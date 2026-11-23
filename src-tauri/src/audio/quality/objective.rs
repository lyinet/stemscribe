//! Rule-based objective score for ranking restoration renders.
//! Lower is better; the Audiobox critic is display/catastrophe-guard only.
//!
//! S = Σ issues in `after` (warn → 1, bad → 3, ok → 0)
//!   + 0.3·max(0, max_harsh_excess_db − 2.0)
//!   + 0.3·max(0, low_mid_excess_db − 1.5)
//!   + 1.0·max(0, (LRA_in − 0.5) − LRA_out)
//!   + 2.0·max(0, TP_out − ceiling_dbtp)
//!   + 0.5·|I_out − target_lufs|

use super::QualityReport;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ObjectiveTerm {
    pub name: String,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ObjectiveScore {
    pub score: f64,
    pub terms: Vec<ObjectiveTerm>,
}

pub fn score(
    after: &QualityReport,
    before: &QualityReport,
    target_lufs: f64,
    ceiling_dbtp: f64,
) -> ObjectiveScore {
    let issues: f64 = after
        .issues
        .iter()
        .map(|i| match i.severity.as_str() {
            "warn" => 1.0,
            "bad" => 3.0,
            _ => 0.0,
        })
        .sum();
    let max_harsh = after
        .harsh_peaks
        .iter()
        .map(|h| h.excess_db as f64)
        .fold(0.0f64, f64::max);
    let harsh = 0.3 * (max_harsh - 2.0).max(0.0);
    let low_mid = 0.3 * (after.low_mid_excess_db as f64 - 1.5).max(0.0);
    let lra = 1.0 * ((before.lra_lu - 0.5) - after.lra_lu).max(0.0);
    let tp = 2.0 * (after.true_peak_dbtp - ceiling_dbtp).max(0.0);
    let lufs = 0.5 * (after.integrated_lufs - target_lufs).abs();

    let terms = vec![
        ObjectiveTerm { name: "issues".into(), value: issues },
        ObjectiveTerm { name: "harsh_excess".into(), value: harsh },
        ObjectiveTerm { name: "low_mid_excess".into(), value: low_mid },
        ObjectiveTerm { name: "lra_loss".into(), value: lra },
        ObjectiveTerm { name: "tp_over_ceiling".into(), value: tp },
        ObjectiveTerm { name: "lufs_distance".into(), value: lufs },
    ];
    let score = issues + harsh + low_mid + lra + tp + lufs;
    ObjectiveScore { score, terms }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::quality::diagnose::{Issue, QualityReport};

    fn report(lra: f64, tp: f64, i: f64) -> QualityReport {
        QualityReport {
            sample_rate: 48_000,
            channels: 2,
            bit_depth: Some(24),
            duration_sec: 1.0,
            integrated_lufs: i,
            lra_lu: lra,
            true_peak_dbtp: tp,
            sample_peak_dbfs: tp,
            cutoff_hz: None,
            low_mid_excess_db: 0.0,
            low_mid_center_hz: 0.0,
            harsh_peaks: vec![],
            stereo_correlation: 0.5,
            side_mid_ratio_db: -10.0,
            low_band_correlation: 0.9,
            clipped_runs: 0,
            dc_offset: [0.0, 0.0],
            ltas: vec![],
            issues: vec![],
        }
    }

    #[test]
    fn score_terms_follow_spec() {
        let before = report(5.0, -3.0, -16.0);
        let mut after = report(3.0, -1.5, -14.5);
        after.issues.push(Issue {
            id: "x".into(),
            severity: "warn".into(),
            title: "t".into(),
            detail: "d".into(),
        });
        after.issues.push(Issue {
            id: "y".into(),
            severity: "bad".into(),
            title: "t".into(),
            detail: "d".into(),
        });
        // issues = 1 + 3 = 4; lra = max(0, (5−0.5)−3) = 1.5;
        // tp = max(0, −1.5+1.0) = 0; lufs = 0.5·|−14.5+14| = 0.25 → S = 5.75
        let s = score(&after, &before, -14.0, -1.0);
        assert!((s.score - 5.75).abs() < 1e-9, "S = {}", s.score);
        assert_eq!(s.terms.len(), 6);
    }
}
