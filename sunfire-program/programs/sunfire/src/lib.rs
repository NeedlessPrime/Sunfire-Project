//! SunFire: trading fees are split between the developer and a burn vault.
//! When NOAA's GOES satellites record an M- or X-class solar flare, or Kp
//! reaches storm level (G4+), a share of the burn vault is spent to buy
//! $SFIRE through Jupiter and burn it.
//!
//! Flow per event:
//!   1. `arm`     – anyone. Reads the Switchboard feed, checks the event is
//!                  new, draws the share and records the exact budget.
//!   2. `execute` – the keeper only. Swaps exactly that budget through
//!                  Jupiter and burns every token bought. Restricted because
//!                  the caller picks `min_out`: an open call would let anyone
//!                  sandwich their own swap and drain the vault.
//!   `disarm`     – keeper or admin. Cancels an armed burn that cannot be
//!                  executed, without moving any lamports.
//!
//! Splitting it in two lets the caller build a Jupiter route for an amount
//! that was decided on-chain, which a single instruction cannot do.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke_signed, sysvar};
use anchor_lang::system_program;
use anchor_spl::token::{self, Burn, Mint, SyncNative, Token, TokenAccount};
use switchboard_on_demand::on_demand::accounts::pull_feed::PullFeedAccountData;

pub mod math;
use math::{Episode, Tier};

declare_id!("5mSUozcjURKYk6f3jmd8yuibZfxcyDg8i7TzdFNPk8ae");

pub const JUPITER_V6: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

pub const CONFIG_SEED: &[u8] = b"config";
pub const FEE_VAULT_SEED: &[u8] = b"fee_vault";
pub const BURN_VAULT_SEED: &[u8] = b"burn_vault";

/// A feed reading older than this many slots (about 1 minute) is refused.
pub const MAX_STALE_SLOTS: u64 = 150;
pub const MIN_SAMPLES: u32 = 1;
/// Lamports kept in each system-owned vault so it stays rent-exempt.
pub const VAULT_FLOOR: u64 = 1_000_000;

#[program]
pub mod sunfire {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        dev_wallet: Pubkey,
        dev_bps: u16,
        xray_feed: Pubkey,
        kp_feed: Pubkey,
        keeper: Pubkey,
    ) -> Result<()> {
        require!(dev_bps <= math::MAX_DEV_BPS, SunfireError::DevShareTooHigh);
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.keeper = keeper;
        c.dev_wallet = dev_wallet;
        c.dev_bps = dev_bps;
        c.sfire_mint = ctx.accounts.sfire_mint.key();
        c.xray_feed = xray_feed;
        c.kp_feed = kp_feed;
        c.bump = ctx.bumps.config;
        c.fee_vault_bump = ctx.bumps.fee_vault;
        c.burn_vault_bump = ctx.bumps.burn_vault;
        Ok(())
    }

    /// Admin settings. Only possible until `renounce` is called.
    pub fn update_settings(
        ctx: Context<AdminOnly>,
        dev_wallet: Pubkey,
        dev_bps: u16,
        xray_feed: Pubkey,
        kp_feed: Pubkey,
        keeper: Pubkey,
    ) -> Result<()> {
        require!(dev_bps <= math::MAX_DEV_BPS, SunfireError::DevShareTooHigh);
        let c = &mut ctx.accounts.config;
        c.keeper = keeper;
        c.dev_wallet = dev_wallet;
        c.dev_bps = dev_bps;
        c.xray_feed = xray_feed;
        c.kp_feed = kp_feed;
        emit!(SettingsUpdated { dev_wallet, dev_bps, xray_feed, kp_feed, keeper });
        Ok(())
    }

    /// Removes the admin forever. Settings are frozen after this.
    pub fn renounce(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.config.admin = Pubkey::default();
        Ok(())
    }

    /// Permissionless. Splits everything in the fee vault between the
    /// developer wallet and the burn vault.
    pub fn distribute(ctx: Context<Distribute>) -> Result<()> {
        let available = ctx.accounts.fee_vault.lamports().saturating_sub(VAULT_FLOOR);
        require!(available > 0, SunfireError::NothingToDistribute);
        let (dev, burn) = math::split_fees(available, ctx.accounts.config.dev_bps);
        let seeds: &[&[u8]] = &[FEE_VAULT_SEED, &[ctx.accounts.config.fee_vault_bump]];
        for (to, amount) in [
            (ctx.accounts.dev_wallet.to_account_info(), dev),
            (ctx.accounts.burn_vault.to_account_info(), burn),
        ] {
            if amount == 0 {
                continue;
            }
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer { from: ctx.accounts.fee_vault.to_account_info(), to },
                    &[seeds],
                ),
                amount,
            )?;
        }
        emit!(FeesDistributed { dev, burn });
        Ok(())
    }

    /// Permissionless. Re-arms triggers once flux is back below M and Kp
    /// back below 8, so the next flare or storm counts as a new event.
    pub fn sync(ctx: Context<Sync>) -> Result<()> {
        let slot = Clock::get()?.slot;
        let xray = read_feed(&ctx.accounts.xray_feed, slot, 9).ok();
        let kp = read_feed(&ctx.accounts.kp_feed, slot, 2).ok();
        let c = &mut ctx.accounts.config;
        let mut e = c.episode();
        e.sync(xray, kp);
        c.set_episode(e);
        Ok(())
    }

    /// Permissionless. Step 1: confirms the event on the oracle and fixes the
    /// budget of the coming buyback.
    pub fn arm(ctx: Context<Arm>, tier: u8) -> Result<()> {
        let tier = tier_from_u8(tier)?;
        let c = &mut ctx.accounts.config;
        require!(c.pending_budget == 0, SunfireError::BurnPending);

        let slot = Clock::get()?.slot;
        let reached = match tier {
            Tier::M | Tier::X => {
                let x = read_feed(&ctx.accounts.xray_feed, slot, 9)?;
                let t = math::flare_tier(x).ok_or(SunfireError::NoEvent)?;
                // An X reading also satisfies an M request.
                tier == t || (tier == Tier::M && t == Tier::X)
            }
            Tier::Storm => read_feed(&ctx.accounts.kp_feed, slot, 2)? >= math::KP_STORM,
        };
        require!(reached, SunfireError::NoEvent);

        let mut e = c.episode();
        require!(e.can_fire(tier), SunfireError::AlreadyTriggered);
        e.mark(tier);
        c.set_episode(e);

        let seed = recent_slot_hash(&ctx.accounts.slot_hashes, c.events)?;
        let bps = math::random_bps(tier, &seed);
        let spendable = ctx.accounts.burn_vault.lamports().saturating_sub(VAULT_FLOOR);
        let budget = math::budget(spendable, bps);
        require!(budget > 0, SunfireError::VaultEmpty);

        c.pending_budget = budget;
        c.pending_tier = tier as u8;
        c.events += 1;
        emit!(BurnArmed { tier: tier as u8, bps, budget, slot });
        Ok(())
    }

    /// Keeper or admin. Cancels an armed burn that cannot be executed (no
    /// Jupiter route, no liquidity), so it does not block every later event.
    /// No lamports move: the budget stays in the burn vault. The event stays
    /// marked as fired, so the same flare cannot be armed again.
    pub fn disarm(ctx: Context<Disarm>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require!(c.pending_budget > 0, SunfireError::NothingArmed);
        let tier = c.pending_tier;
        let budget = c.pending_budget;
        c.pending_budget = 0;
        emit!(BurnDisarmed { tier, budget, by: ctx.accounts.authority.key() });
        Ok(())
    }

    /// Keeper only. Step 2: swaps the armed budget through Jupiter and
    /// burns every $SFIRE received. `jupiter_data` is the swap instruction
    /// data from Jupiter's API, built with the burn vault as the user and
    /// the armed budget as the input amount. Route accounts go in
    /// remaining_accounts.
    pub fn execute<'info>(
        ctx: Context<'_, '_, 'info, 'info, Execute<'info>>,
        jupiter_data: Vec<u8>,
        min_out: u64,
    ) -> Result<()> {
        let budget = ctx.accounts.config.pending_budget;
        require!(budget > 0, SunfireError::NothingArmed);
        let vault_bump = ctx.accounts.config.burn_vault_bump;
        let vault_seeds: &[&[u8]] = &[BURN_VAULT_SEED, &[vault_bump]];

        // Wrap the budget into the vault's wSOL account.
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.burn_vault.to_account_info(),
                    to: ctx.accounts.vault_wsol.to_account_info(),
                },
                &[vault_seeds],
            ),
            budget,
        )?;
        token::sync_native(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            SyncNative { account: ctx.accounts.vault_wsol.to_account_info() },
        ))?;
        ctx.accounts.vault_wsol.reload()?;

        let wsol_before = ctx.accounts.vault_wsol.amount;
        let sfire_before = ctx.accounts.vault_sfire.amount;
        let lamports_before = ctx.accounts.burn_vault.lamports();
        let vault_key = ctx.accounts.burn_vault.key();

        // Swap through Jupiter, signed by the burn vault.
        let metas = ctx
            .remaining_accounts
            .iter()
            .map(|a| AccountMeta {
                pubkey: a.key(),
                is_signer: a.key() == vault_key || a.is_signer,
                is_writable: a.is_writable,
            })
            .collect();
        invoke_signed(
            &Instruction { program_id: JUPITER_V6, accounts: metas, data: jupiter_data },
            ctx.remaining_accounts,
            &[vault_seeds],
        )?;

        ctx.accounts.vault_wsol.reload()?;
        ctx.accounts.vault_sfire.reload()?;
        let spent = wsol_before.saturating_sub(ctx.accounts.vault_wsol.amount);
        let bought = ctx.accounts.vault_sfire.amount.saturating_sub(sfire_before);
        require!(spent <= budget, SunfireError::OverBudget);
        require!(bought >= min_out && bought > 0, SunfireError::SlippageExceeded);
        require!(ctx.accounts.burn_vault.lamports() == lamports_before, SunfireError::VaultTouched);

        // Burn everything the vault holds, including any earlier leftovers.
        let to_burn = ctx.accounts.vault_sfire.amount;
        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.sfire_mint.to_account_info(),
                    from: ctx.accounts.vault_sfire.to_account_info(),
                    authority: ctx.accounts.burn_vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            to_burn,
        )?;

        let executor = ctx.accounts.executor.key();
        let c = &mut ctx.accounts.config;
        let tier = c.pending_tier;
        c.pending_budget = 0;
        c.total_burned = c.total_burned.saturating_add(to_burn);
        c.total_sol_spent = c.total_sol_spent.saturating_add(spent);
        emit!(Burned { tier, sol_spent: spent, sfire_burned: to_burn, executor });
        Ok(())
    }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/// Reads a Switchboard pull feed and returns its value multiplied by
/// 10^`mul_pow`. The X-ray feed reports W/m² (mul 9), the Kp feed reports Kp (mul 2).
fn read_feed(feed: &AccountInfo, slot: u64, mul_pow: u32) -> Result<u64> {
    require_keys_eq!(*feed.owner, switchboard_on_demand::sb_pid(), SunfireError::BadFeed);
    let data = feed.try_borrow_data()?;
    let parsed = PullFeedAccountData::parse(data).map_err(|_| error!(SunfireError::BadFeed))?;
    let value = parsed
        .get_value(slot, MAX_STALE_SLOTS, MIN_SAMPLES, false)
        .map_err(|_| error!(SunfireError::StaleFeed))?;
    math::scaled_u64(value.mantissa(), value.scale(), mul_pow).ok_or_else(|| error!(SunfireError::BadFeed))
}

/// Most recent slot hash mixed with the event counter.
fn recent_slot_hash(slot_hashes: &AccountInfo, nonce: u64) -> Result<[u8; 32]> {
    require_keys_eq!(slot_hashes.key(), sysvar::slot_hashes::ID, SunfireError::BadSysvar);
    let data = slot_hashes.try_borrow_data()?;
    // Layout: u64 count, then (u64 slot, [u8; 32] hash) entries, newest first.
    require!(data.len() >= 8 + 8 + 32, SunfireError::BadSysvar);
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&data[16..48]);
    for (i, b) in nonce.to_le_bytes().iter().enumerate() {
        seed[i] ^= b;
    }
    Ok(seed)
}

fn tier_from_u8(t: u8) -> Result<Tier> {
    match t {
        0 => Ok(Tier::M),
        1 => Ok(Tier::X),
        2 => Ok(Tier::Storm),
        _ => err!(SunfireError::BadTier),
    }
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Pubkey::default() once renounced.
    pub admin: Pubkey,
    /// The only signer allowed to run `execute`.
    pub keeper: Pubkey,
    pub dev_wallet: Pubkey,
    pub dev_bps: u16,
    pub sfire_mint: Pubkey,
    pub xray_feed: Pubkey,
    pub kp_feed: Pubkey,
    pub m_fired: bool,
    pub x_fired: bool,
    pub storm_fired: bool,
    pub pending_budget: u64,
    pub pending_tier: u8,
    pub events: u64,
    pub total_burned: u64,
    pub total_sol_spent: u64,
    pub bump: u8,
    pub fee_vault_bump: u8,
    pub burn_vault_bump: u8,
}

impl Config {
    fn episode(&self) -> Episode {
        Episode { m_fired: self.m_fired, x_fired: self.x_fired, storm_fired: self.storm_fired }
    }
    fn set_episode(&mut self, e: Episode) {
        self.m_fired = e.m_fired;
        self.x_fired = e.x_fired;
        self.storm_fired = e.storm_fired;
    }
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// Only the program's upgrade authority can initialize, so nobody can
    /// front-run the deployment and set their own dev wallet.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ SunfireError::NotAdmin)]
    pub program: Program<'info, crate::program::Sunfire>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ SunfireError::NotAdmin)]
    pub program_data: Account<'info, ProgramData>,
    /// CHECK: system-owned PDA that receives trading fees.
    #[account(seeds = [FEE_VAULT_SEED], bump)]
    pub fee_vault: UncheckedAccount<'info>,
    /// CHECK: system-owned PDA that holds the burn share.
    #[account(seeds = [BURN_VAULT_SEED], bump)]
    pub burn_vault: UncheckedAccount<'info>,
    pub sfire_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ SunfireError::NotAdmin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct Distribute<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = dev_wallet)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [FEE_VAULT_SEED], bump = config.fee_vault_bump)]
    pub fee_vault: SystemAccount<'info>,
    #[account(mut, seeds = [BURN_VAULT_SEED], bump = config.burn_vault_bump)]
    pub burn_vault: SystemAccount<'info>,
    /// CHECK: matched against config.dev_wallet.
    #[account(mut)]
    pub dev_wallet: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sync<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: owner and layout checked in read_feed.
    #[account(address = config.xray_feed @ SunfireError::BadFeed)]
    pub xray_feed: UncheckedAccount<'info>,
    /// CHECK: owner and layout checked in read_feed.
    #[account(address = config.kp_feed @ SunfireError::BadFeed)]
    pub kp_feed: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Arm<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [BURN_VAULT_SEED], bump = config.burn_vault_bump)]
    pub burn_vault: SystemAccount<'info>,
    /// CHECK: owner and layout checked in read_feed.
    #[account(address = config.xray_feed @ SunfireError::BadFeed)]
    pub xray_feed: UncheckedAccount<'info>,
    /// CHECK: owner and layout checked in read_feed.
    #[account(address = config.kp_feed @ SunfireError::BadFeed)]
    pub kp_feed: UncheckedAccount<'info>,
    /// CHECK: address checked in recent_slot_hash.
    pub slot_hashes: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Disarm<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut, seeds = [CONFIG_SEED], bump = config.bump,
        constraint = authority.key() == config.keeper
            || (config.admin != Pubkey::default() && authority.key() == config.admin)
            @ SunfireError::NotKeeper
    )]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    pub executor: Signer<'info>,
    #[account(
        mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = sfire_mint,
        constraint = config.keeper == executor.key() @ SunfireError::NotKeeper
    )]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [BURN_VAULT_SEED], bump = config.burn_vault_bump)]
    pub burn_vault: SystemAccount<'info>,
    #[account(mut, token::mint = wsol_mint, token::authority = burn_vault)]
    pub vault_wsol: Account<'info, TokenAccount>,
    #[account(mut, token::mint = sfire_mint, token::authority = burn_vault)]
    pub vault_sfire: Account<'info, TokenAccount>,
    #[account(mut)]
    pub sfire_mint: Account<'info, Mint>,
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Account<'info, Mint>,
    /// CHECK: pinned to Jupiter v6.
    #[account(address = JUPITER_V6)]
    pub jupiter_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/* ------------------------------------------------------------------ */
/* Events and errors                                                   */
/* ------------------------------------------------------------------ */

#[event]
pub struct SettingsUpdated {
    pub keeper: Pubkey,
    pub dev_wallet: Pubkey,
    pub dev_bps: u16,
    pub xray_feed: Pubkey,
    pub kp_feed: Pubkey,
}
#[event]
pub struct FeesDistributed {
    pub dev: u64,
    pub burn: u64,
}
#[event]
pub struct BurnArmed {
    pub tier: u8,
    pub bps: u64,
    pub budget: u64,
    pub slot: u64,
}
#[event]
pub struct BurnDisarmed {
    pub tier: u8,
    pub budget: u64,
    pub by: Pubkey,
}
#[event]
pub struct Burned {
    pub tier: u8,
    pub sol_spent: u64,
    pub sfire_burned: u64,
    pub executor: Pubkey,
}

#[error_code]
pub enum SunfireError {
    #[msg("Developer share cannot exceed 50 %")]
    DevShareTooHigh,
    #[msg("Only the admin can do this, and only before renouncing")]
    NotAdmin,
    #[msg("The fee vault is empty")]
    NothingToDistribute,
    #[msg("Feed account is not the configured Switchboard feed")]
    BadFeed,
    #[msg("Feed value is stale or has too few samples")]
    StaleFeed,
    #[msg("Unknown event tier")]
    BadTier,
    #[msg("The feed does not show this event")]
    NoEvent,
    #[msg("This event was already burned")]
    AlreadyTriggered,
    #[msg("A burn is already armed. Execute it first")]
    BurnPending,
    #[msg("No burn is armed")]
    NothingArmed,
    #[msg("The burn vault is empty")]
    VaultEmpty,
    #[msg("The swap spent more than the armed budget")]
    OverBudget,
    #[msg("The swap returned fewer tokens than the minimum")]
    SlippageExceeded,
    #[msg("The swap moved SOL out of the burn vault")]
    VaultTouched,
    #[msg("Wrong sysvar account")]
    BadSysvar,
    #[msg("Only the keeper (or the admin, for disarm) can do this")]
    NotKeeper,
}
