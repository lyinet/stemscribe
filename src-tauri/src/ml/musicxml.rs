use crate::audio::chords::ChordEvent;
use crate::ml::transcriber::MidiNote;
use anyhow::Result;
use std::fmt::Write as FmtWrite;
use std::path::Path;

const STEPS: [(&str, Option<i8>); 12] = [
    ("C", None),
    ("C", Some(1)),
    ("D", None),
    ("E", Some(-1)),
    ("E", None),
    ("F", None),
    ("F", Some(1)),
    ("G", None),
    ("A", Some(-1)),
    ("A", None),
    ("B", Some(-1)),
    ("B", None),
];

/// Export transcribed MIDI notes and chord symbols to standard MusicXML 4.0 (.musicxml)
/// compatible with MuseScore, Guitar Pro, Sibelius, Finale, and Logic Pro.
pub fn write_musicxml_file(
    title: &str,
    notes: &[MidiNote],
    chords: &[ChordEvent],
    bpm: f32,
    save_path: &str,
) -> Result<String> {
    let divisions: i32 = 4; // 16th-note resolution per quarter note
    let beat_sec = 60.0 / bpm.clamp(40.0, 240.0) as f64;
    let measure_sec = beat_sec * 4.0;
    let total_sec = notes
        .iter()
        .map(|n| n.end_sec)
        .fold(measure_sec, f64::max);
    let num_measures = ((total_sec / measure_sec).ceil() as usize).max(1);

    let mut xml = String::with_capacity(8192);
    writeln!(xml, r#"<?xml version="1.0" encoding="UTF-8"?>"#)?;
    writeln!(
        xml,
        r#"<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">"#
    )?;
    writeln!(xml, r#"<score-partwise version="4.0">"#)?;
    writeln!(
        xml,
        "  <work><work-title>{}</work-title></work>",
        escape_xml(title)
    )?;
    writeln!(
        xml,
        "  <identification><encoding><software>StemScribe v{}</software></encoding></identification>", env!("CARGO_PKG_VERSION")
    )?;
    writeln!(xml, r#"  <part-list>"#)?;
    writeln!(
        xml,
        r#"    <score-part id="P1"><part-name>Transcribed Track</part-name></score-part>"#
    )?;
    writeln!(xml, r#"  </part-list>"#)?;
    writeln!(xml, r#"  <part id="P1">"#)?;

    for m in 0..num_measures {
        let m_start = m as f64 * measure_sec;
        let m_end = m_start + measure_sec;
        writeln!(xml, r#"    <measure number="{}">"#, m + 1)?;

        if m == 0 {
            writeln!(xml, "      <attributes>")?;
            writeln!(xml, "        <divisions>{divisions}</divisions>")?;
            writeln!(xml, "        <key><fifths>0</fifths></key>")?;
            writeln!(xml, "        <time><beats>4</beats><beat-type>4</beat-type></time>")?;
            writeln!(xml, "        <clef><sign>G</sign><line>2</line></clef>")?;
            writeln!(xml, "      </attributes>")?;
            writeln!(
                xml,
                r#"      <sound tempo="{:.1}"/>"#,
                bpm.clamp(40.0, 240.0)
            )?;
        }

        // Attach chord harmony symbol if a chord starts in this measure
        if let Some(ch) = chords
            .iter()
            .find(|c| c.start_sec >= m_start - 0.1 && c.start_sec < m_end && c.symbol != "N")
        {
            if let Some((root_step, root_alter, kind)) = parse_chord_for_musicxml(&ch.symbol) {
                writeln!(xml, "      <harmony>")?;
                writeln!(xml, "        <root><root-step>{root_step}</root-step>")?;
                if let Some(alt) = root_alter {
                    writeln!(xml, "          <root-alter>{alt}</root-alter>")?;
                }
                writeln!(xml, "        </root>")?;
                writeln!(xml, "        <kind>{kind}</kind>")?;
                writeln!(xml, "      </harmony>")?;
            }
        }

        let measure_notes: Vec<&MidiNote> = notes
            .iter()
            .filter(|n| n.start_sec >= m_start && n.start_sec < m_end)
            .collect();

        if measure_notes.is_empty() {
            writeln!(
                xml,
                "      <note><rest/><duration>{}</duration><type>whole</type></note>",
                divisions * 4
            )?;
        } else {
            let mut written_divs = 0;
            for n in measure_notes.iter().take(16) {
                let dur_beats = ((n.end_sec - n.start_sec) / beat_sec).clamp(0.25, 4.0);
                let dur_divs = ((dur_beats * divisions as f64).round() as i32).clamp(1, 16);
                let (step, alter) = STEPS[(n.pitch % 12) as usize];
                let octave = (n.pitch as i32 / 12) - 1;
                let note_type = match dur_divs {
                    1 => "16th",
                    2..=3 => "eighth",
                    4..=6 => "quarter",
                    7..=12 => "half",
                    _ => "whole",
                };

                writeln!(xml, "      <note>")?;
                writeln!(xml, "        <pitch>")?;
                writeln!(xml, "          <step>{step}</step>")?;
                if let Some(a) = alter {
                    writeln!(xml, "          <alter>{a}</alter>")?;
                }
                writeln!(xml, "          <octave>{octave}</octave>")?;
                writeln!(xml, "        </pitch>")?;
                writeln!(xml, "        <duration>{dur_divs}</duration>")?;
                writeln!(xml, "        <type>{note_type}</type>")?;
                writeln!(xml, "      </note>")?;
                written_divs += dur_divs;
                if written_divs >= divisions * 4 {
                    break;
                }
            }
        }

        writeln!(xml, "    </measure>")?;
    }

    writeln!(xml, "  </part>")?;
    writeln!(xml, "</score-partwise>")?;

    let path = Path::new(save_path);
    std::fs::write(path, xml)?;
    Ok(path.to_string_lossy().to_string())
}

fn parse_chord_for_musicxml(symbol: &str) -> Option<(&'static str, Option<i8>, &'static str)> {
    let bytes = symbol.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    let step = match bytes[0] as char {
        'C' => "C",
        'D' => "D",
        'E' => "E",
        'F' => "F",
        'G' => "G",
        'A' => "A",
        'B' => "B",
        _ => return None,
    };
    let mut rest = &symbol[1..];
    let alter = if rest.starts_with('#') {
        rest = &rest[1..];
        Some(1)
    } else if rest.starts_with('b') {
        rest = &rest[1..];
        Some(-1)
    } else {
        None
    };
    let kind = if rest.starts_with('m') {
        "minor"
    } else if rest.starts_with('7') {
        "dominant"
    } else {
        "major"
    };
    Some((step, alter, kind))
}

fn escape_xml(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
