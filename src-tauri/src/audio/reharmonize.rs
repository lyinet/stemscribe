use crate::audio::chords::ChordEvent;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReharmonizeResult {
    pub style: String,
    pub style_label_zh: String,
    pub description: String,
    pub chords: Vec<ChordEvent>,
}

const NOTE_SHARP: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

fn parse_chord(sym: &str) -> Option<(usize, String)> {
    let s = sym.trim();
    if s.is_empty() {
        return None;
    }
    let bytes = s.as_bytes();
    let base = match bytes[0] as char {
        'C' => 0,
        'D' => 2,
        'E' => 4,
        'F' => 5,
        'G' => 7,
        'A' => 9,
        'B' => 11,
        _ => return None,
    };
    let mut pc = base;
    let mut rest_idx = 1;
    if bytes.len() > 1 {
        if bytes[1] as char == '#' {
            pc = (pc + 1) % 12;
            rest_idx = 2;
        } else if bytes[1] as char == 'b' {
            pc = (pc + 11) % 12;
            rest_idx = 2;
        }
    }
    Some((pc, s[rest_idx..].to_string()))
}

fn is_minor_suffix(suffix: &str) -> bool {
    let low = suffix.to_lowercase();
    low.starts_with('m') && !low.starts_with("maj")
}

/// Reharmonize an existing chord progression into one of 4 curated musical styles:
/// - "jazz_neosoul" (City Pop / Neo-Soul lush 7th & 9th extensions)
/// - "folk_open" (Acoustic fingerstyle add9 / sus2 / maj7 color)
/// - "cinematic_minor" (Epic / dark modal interchange & relative minor color)
/// - "pop_beginner" (Clean simplified triads for beginners)
pub fn reharmonize_chords(chords: &[ChordEvent], style: &str) -> ReharmonizeResult {
    let (style_label_zh, description) = match style {
        "jazz_neosoul" => (
            "爵士 / City Pop 色彩",
            "将基础三和弦扩展为 maj7 / m7 / 9 色彩和弦，提升律动与高级听感",
        ),
        "folk_open" => (
            "民谣指弹清新",
            "加入 add9 / sus2 / maj7 开放弦色彩，适合木吉他扫弦与分解和弦",
        ),
        "cinematic_minor" => (
            "暗黑电影感变奏",
            "引入平行小调与悬留和弦替代，营造史诗与情绪张力",
        ),
        _ => (
            "流行极简新手版",
            "剥离复杂延伸音，还原为最易上手的标准大小三和弦",
        ),
    };

    let transformed: Vec<ChordEvent> = chords
        .iter()
        .enumerate()
        .map(|(idx, ch)| {
            let new_sym = if let Some((pc, suffix)) = parse_chord(&ch.symbol) {
                let root = NOTE_SHARP[pc];
                let minor = is_minor_suffix(&suffix);
                let dom7 = suffix.starts_with('7');
                match style {
                    "jazz_neosoul" => {
                        if minor {
                            format!("{root}m9")
                        } else if dom7 {
                            format!("{root}13")
                        } else {
                            format!("{root}maj7")
                        }
                    }
                    "folk_open" => {
                        if minor {
                            format!("{root}m7")
                        } else if dom7 {
                            format!("{root}7sus4")
                        } else if idx % 2 == 0 {
                            format!("{root}add9")
                        } else {
                            format!("{root}maj7")
                        }
                    }
                    "cinematic_minor" => {
                        if !minor && idx % 3 == 2 {
                            // Relative minor substitution
                            let rel_minor = NOTE_SHARP[(pc + 9) % 12];
                            format!("{rel_minor}m7")
                        } else if minor {
                            format!("{root}m9")
                        } else {
                            format!("{root}sus2")
                        }
                    }
                    _ => {
                        // pop_beginner
                        if minor {
                            format!("{root}m")
                        } else {
                            root.to_string()
                        }
                    }
                }
            } else {
                ch.symbol.clone()
            };

            ChordEvent {
                start_sec: ch.start_sec,
                end_sec: ch.end_sec,
                symbol: new_sym,
                confidence: ch.confidence,
            }
        })
        .collect();

    ReharmonizeResult {
        style: style.to_string(),
        style_label_zh: style_label_zh.to_string(),
        description: description.to_string(),
        chords: transformed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reharmonize_jazz_and_beginner_styles() {
        let base = vec![
            ChordEvent { start_sec: 0.0, end_sec: 4.0, symbol: "C".into(), confidence: 0.95 },
            ChordEvent { start_sec: 4.0, end_sec: 8.0, symbol: "Am".into(), confidence: 0.93 },
            ChordEvent { start_sec: 8.0, end_sec: 12.0, symbol: "G7".into(), confidence: 0.92 },
        ];

        let jazz = reharmonize_chords(&base, "jazz_neosoul");
        assert_eq!(jazz.chords[0].symbol, "Cmaj7");
        assert_eq!(jazz.chords[1].symbol, "Am9");
        assert_eq!(jazz.chords[2].symbol, "G13");

        let simple = reharmonize_chords(&jazz.chords, "pop_beginner");
        assert_eq!(simple.chords[0].symbol, "C");
        assert_eq!(simple.chords[1].symbol, "Am");
        assert_eq!(simple.chords[2].symbol, "G");
    }
}
