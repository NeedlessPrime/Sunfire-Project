//! Pure logic, kept free of Solana types so it can be unit-tested on any machine.

/// The program scales raw feed values before comparing them. X-ray flux in
/// W/m² is multiplied by 1e9, so an M1.0 flare (1e-5 W/m²) reads 10_000.
pub const XRAY_SCALE_M: u64 = 10_000;
pub const XRAY_SCALE_X: u64 = 100_000;
/// Kp is multiplied by 100. G4 starts at Kp 8.
pub const KP_STORM: u64 = 800;

pub const BPS: u64 = 10_000;
/// The developer can never take more than half of the fees.
pub const MAX_DEV_BPS: u16 = 5_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    M,
    X,
    Storm,
}

impl Tier {
    /// Share of the burn vault spent on one event, as an inclusive bps range.
    pub fn range_bps(self) -> (u64, u64) {
        match self {
            Tier::M => (100, 500),       // 1–5 %
            Tier::X => (1_000, 2_500),   // 10–25 %
            Tier::Storm => (3_000, 5_000), // 30–50 %
        }
    }
}

/// Which flare tier a scaled X-ray reading reaches, if any.
pub fn flare_tier(xray: u64) -> Option<Tier> {
    if xray >= XRAY_SCALE_X {
        Some(Tier::X)
    } else if xray >= XRAY_SCALE_M {
        Some(Tier::M)
    } else {
        None
    }
}

/// One flare episode can fire M once and X once. An M that grows into an X
/// fires both. The flags reset only when flux drops back below M.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Episode {
    pub m_fired: bool,
    pub x_fired: bool,
    pub storm_fired: bool,
}

impl Episode {
    pub fn can_fire(&self, tier: Tier) -> bool {
        match tier {
            Tier::M => !self.m_fired && !self.x_fired,
            Tier::X => !self.x_fired,
            Tier::Storm => !self.storm_fired,
        }
    }

    pub fn mark(&mut self, tier: Tier) {
        match tier {
            Tier::M => self.m_fired = true,
            Tier::X => {
                self.m_fired = true;
                self.x_fired = true;
            }
            Tier::Storm => self.storm_fired = true,
        }
    }

    /// Re-arm triggers once conditions are quiet again.
    pub fn sync(&mut self, xray: Option<u64>, kp: Option<u64>) {
        if let Some(x) = xray {
            if x < XRAY_SCALE_M {
                self.m_fired = false;
                self.x_fired = false;
            }
        }
        if let Some(k) = kp {
            if k < KP_STORM {
                self.storm_fired = false;
            }
        }
    }
}

/// Picks a share inside the tier's range from 32 random bytes.
pub fn random_bps(tier: Tier, seed: &[u8; 32]) -> u64 {
    let (lo, hi) = tier.range_bps();
    let mut r = [0u8; 8];
    r.copy_from_slice(&seed[..8]);
    lo + u64::from_le_bytes(r) % (hi - lo + 1)
}

/// Lamports spent on one buyback.
pub fn budget(spendable: u64, bps: u64) -> u64 {
    ((spendable as u128) * (bps as u128) / (BPS as u128)) as u64
}

/// Splits collected fees into (dev, burn vault).
pub fn split_fees(amount: u64, dev_bps: u16) -> (u64, u64) {
    let dev = ((amount as u128) * (dev_bps as u128) / (BPS as u128)) as u64;
    (dev, amount - dev)
}

/// Converts a fixed-point value (mantissa, scale) to an integer multiplied by
/// 10^`mul_pow`, rounding down. Negative values return None.
pub fn scaled_u64(mantissa: i128, scale: u32, mul_pow: u32) -> Option<u64> {
    if mantissa < 0 {
        return None;
    }
    let m = mantissa as u128;
    let v = if mul_pow >= scale {
        m.checked_mul(10u128.checked_pow(mul_pow - scale)?)?
    } else {
        m / 10u128.checked_pow(scale - mul_pow)?
    };
    u64::try_from(v).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiers_follow_noaa_scale() {
        assert_eq!(flare_tier(9_999), None); // C9.9
        assert_eq!(flare_tier(10_000), Some(Tier::M)); // M1.0
        assert_eq!(flare_tier(99_999), Some(Tier::M)); // M9.9
        assert_eq!(flare_tier(100_000), Some(Tier::X)); // X1.0
    }

    #[test]
    fn one_flare_fires_once_per_tier() {
        let mut e = Episode::default();
        assert!(e.can_fire(Tier::M));
        e.mark(Tier::M);
        assert!(!e.can_fire(Tier::M));
        assert!(e.can_fire(Tier::X), "an M growing into an X still fires X");
        e.mark(Tier::X);
        assert!(!e.can_fire(Tier::X));
        e.sync(Some(50_000), None); // still M level: no re-arm
        assert!(!e.can_fire(Tier::M));
        e.sync(Some(2_000), None); // back to C: re-armed
        assert!(e.can_fire(Tier::M) && e.can_fire(Tier::X));
    }

    #[test]
    fn x_without_prior_m_blocks_later_m() {
        let mut e = Episode::default();
        e.mark(Tier::X);
        assert!(!e.can_fire(Tier::M));
    }

    #[test]
    fn storm_rearms_below_kp8() {
        let mut e = Episode::default();
        e.mark(Tier::Storm);
        e.sync(None, Some(850));
        assert!(!e.can_fire(Tier::Storm));
        e.sync(None, Some(700));
        assert!(e.can_fire(Tier::Storm));
    }

    #[test]
    fn random_share_stays_in_range() {
        for t in [Tier::M, Tier::X, Tier::Storm] {
            let (lo, hi) = t.range_bps();
            for i in 0..=255u8 {
                let mut seed = [i; 32];
                seed[0] = i.wrapping_mul(37);
                let b = random_bps(t, &seed);
                assert!(b >= lo && b <= hi);
            }
        }
    }

    #[test]
    fn fee_split_adds_up() {
        assert_eq!(split_fees(1_000_000, 5_000), (500_000, 500_000));
        assert_eq!(split_fees(999, 3_000), (299, 700));
        assert_eq!(split_fees(u64::MAX, 5_000).0 + split_fees(u64::MAX, 5_000).1, u64::MAX);
    }

    #[test]
    fn budget_math() {
        assert_eq!(budget(10_000_000_000, 100), 100_000_000); // 1 % of 10 SOL
        assert_eq!(budget(u64::MAX, 5_000), u64::MAX / 2);
    }

    #[test]
    fn decimal_conversion() {
        // Switchboard precision is 18 decimals. 1.5e-5 W/m² * 1e9 = 15_000.
        let flux = 15_000_000_000_000i128; // 0.000015 with scale 18
        assert_eq!(scaled_u64(flux, 18, 9), Some(15_000));
        // Kp 8.33 -> 833
        assert_eq!(scaled_u64(833, 2, 2), Some(833));
        assert_eq!(scaled_u64(8_330_000_000_000_000_000, 18, 2), Some(833));
        assert_eq!(scaled_u64(-1, 18, 2), None);
    }
}
