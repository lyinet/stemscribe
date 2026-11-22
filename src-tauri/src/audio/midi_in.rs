use anyhow::{anyhow, Result};
use midir::{Ignore, MidiInput, MidiInputConnection};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MidiInputPortInfo {
    pub index: usize,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareMidiEvent {
    pub kind: String, // "noteon" | "noteoff"
    pub pitch: u8,
    pub velocity: u8,
    pub device_name: String,
}

static ACTIVE_MIDI_CONN: OnceLock<Mutex<Option<MidiInputConnection<()>>>> = OnceLock::new();

fn conn_slot() -> &'static Mutex<Option<MidiInputConnection<()>>> {
    ACTIVE_MIDI_CONN.get_or_init(|| Mutex::new(None))
}

/// Pure MIDI 3-byte channel message parser for Note On / Note Off events.
pub fn parse_midi_message(bytes: &[u8], device_name: &str) -> Option<HardwareMidiEvent> {
    if bytes.len() < 3 {
        return None;
    }
    let status = bytes[0] & 0xF0;
    let pitch = bytes[1] & 0x7F;
    let velocity = bytes[2] & 0x7F;

    if status == 0x90 && velocity > 0 {
        Some(HardwareMidiEvent {
            kind: "noteon".to_string(),
            pitch,
            velocity,
            device_name: device_name.to_string(),
        })
    } else if status == 0x80 || (status == 0x90 && velocity == 0) {
        Some(HardwareMidiEvent {
            kind: "noteoff".to_string(),
            pitch,
            velocity: 0,
            device_name: device_name.to_string(),
        })
    } else {
        None
    }
}

pub fn list_midi_inputs() -> Result<Vec<MidiInputPortInfo>> {
    let midi_in = MidiInput::new("StemScribe MIDI Scanner")
        .map_err(|e| anyhow!("CoreMIDI 初始化失败: {e}"))?;
    let mut out = Vec::new();
    for (index, port) in midi_in.ports().iter().enumerate() {
        let name = midi_in
            .port_name(port)
            .unwrap_or_else(|_| format!("USB MIDI Device #{index}"));
        out.push(MidiInputPortInfo { index, name });
    }
    Ok(out)
}

pub fn connect_midi_input(app: AppHandle, port_index: usize) -> Result<String> {
    // Drop any previous connection first
    {
        let mut guard = conn_slot().lock().map_err(|_| anyhow!("MIDI lock poisoned"))?;
        *guard = None;
    }

    let mut midi_in =
        MidiInput::new("StemScribe CoreMIDI Input").map_err(|e| anyhow!("CoreMIDI 初始化失败: {e}"))?;
    midi_in.ignore(Ignore::None);

    let ports = midi_in.ports();
    let port = ports
        .get(port_index)
        .ok_or_else(|| anyhow!("未找到索引为 {port_index} 的 USB-MIDI 设备"))?;
    let device_name = midi_in
        .port_name(port)
        .unwrap_or_else(|_| format!("USB MIDI Device #{port_index}"));
    let device_name_cb = device_name.clone();

    let conn = midi_in
        .connect(
            port,
            "stemscribe-midi-in",
            move |_stamp, message, _| {
                if let Some(evt) = parse_midi_message(message, &device_name_cb) {
                    let _ = app.emit("hardware-midi-note", evt);
                }
            },
            (),
        )
        .map_err(|e| anyhow!("连接 USB-MIDI 设备失败: {e}"))?;

    let mut guard = conn_slot().lock().map_err(|_| anyhow!("MIDI lock poisoned"))?;
    *guard = Some(conn);
    Ok(device_name)
}

pub fn disconnect_midi_input() -> Result<()> {
    let mut guard = conn_slot().lock().map_err(|_| anyhow!("MIDI lock poisoned"))?;
    *guard = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_midi_note_on_off() {
        let on = parse_midi_message(&[0x90, 60, 100], "Keystation").unwrap();
        assert_eq!(on.kind, "noteon");
        assert_eq!(on.pitch, 60);
        assert_eq!(on.velocity, 100);

        let off_vel0 = parse_midi_message(&[0x90, 60, 0], "Keystation").unwrap();
        assert_eq!(off_vel0.kind, "noteoff");

        let off = parse_midi_message(&[0x80, 64, 0], "Keystation").unwrap();
        assert_eq!(off.kind, "noteoff");
        assert_eq!(off.pitch, 64);

        assert!(parse_midi_message(&[0xB0, 64, 127], "Keystation").is_none());
    }
}
