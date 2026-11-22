import {
  connectMidiInput,
  disconnectMidiInput,
  isTauriRuntime,
  listMidiInputs,
  onHardwareMidiNote,
} from "./tauriApi";

export interface MidiInputDeviceInfo {
  id: string;
  name: string;
  manufacturer: string;
}

export interface MidiNoteEvent {
  type: "noteon" | "noteoff";
  pitch: number;
  velocity: number;
  deviceName: string;
}

interface WebMidiInputPort {
  id: string;
  name?: string | null;
  manufacturer?: string | null;
  onmidimessage: ((event: { data: Uint8Array }) => void) | null;
}

interface WebMidiAccess {
  inputs: Map<string, WebMidiInputPort>;
  onstatechange: (() => void) | null;
}

/**
 * Dual-mode hardware USB-MIDI bridge:
 * - On macOS Tauri desktop: uses native Rust CoreMIDI (`midir`) via Tauri IPC + events.
 * - In browser preview: falls back to browser Web MIDI API when supported.
 */
export class HardwareMidiBridge {
  private access: WebMidiAccess | null = null;
  private tauriUnlisten: (() => void) | null = null;
  private onNoteCb?: (evt: MidiNoteEvent) => void;
  private onDevicesCb?: (devices: MidiInputDeviceInfo[]) => void;

  public async connect(
    onNote: (evt: MidiNoteEvent) => void,
    onDevices: (devices: MidiInputDeviceInfo[]) => void
  ): Promise<MidiInputDeviceInfo[]> {
    this.disconnect();
    this.onNoteCb = onNote;
    this.onDevicesCb = onDevices;

    if (isTauriRuntime()) {
      const ports = await listMidiInputs();
      const devices: MidiInputDeviceInfo[] = ports.map((p) => ({
        id: String(p.index),
        name: p.name,
        manufacturer: "CoreMIDI",
      }));
      this.onDevicesCb?.(devices);
      if (ports.length === 0) {
        return [];
      }
      this.tauriUnlisten = await onHardwareMidiNote((evt) => {
        this.onNoteCb?.({
          type: evt.kind === "noteon" ? "noteon" : "noteoff",
          pitch: evt.pitch,
          velocity: evt.velocity,
          deviceName: evt.device_name,
        });
      });
      await connectMidiInput(ports[0].index);
      return devices;
    }

    const nav = navigator as unknown as {
      requestMIDIAccess?: (opts?: { sysex: boolean }) => Promise<WebMidiAccess>;
    };
    if (!nav.requestMIDIAccess) {
      throw new Error("当前浏览器环境不支持 Web MIDI API；请在 macOS 桌面端使用原生 CoreMIDI 接入");
    }

    const access = await nav.requestMIDIAccess({ sysex: false });
    this.access = access;
    access.onstatechange = () => {
      this.bindAllBrowserInputs();
    };
    return this.bindAllBrowserInputs();
  }

  private bindAllBrowserInputs(): MidiInputDeviceInfo[] {
    if (!this.access) return [];
    const devices: MidiInputDeviceInfo[] = [];
    this.access.inputs.forEach((port) => {
      const name = port.name || "USB MIDI Controller";
      devices.push({
        id: port.id,
        name,
        manufacturer: port.manufacturer || "",
      });
      port.onmidimessage = (e) => {
        if (!e.data || e.data.length < 3) return;
        const status = e.data[0] & 0xf0;
        const pitch = e.data[1];
        const velocity = e.data[2];
        if (status === 0x90 && velocity > 0) {
          this.onNoteCb?.({ type: "noteon", pitch, velocity, deviceName: name });
        } else if (status === 0x80 || (status === 0x90 && velocity === 0)) {
          this.onNoteCb?.({ type: "noteoff", pitch, velocity: 0, deviceName: name });
        }
      };
    });
    this.onDevicesCb?.(devices);
    return devices;
  }

  public disconnect() {
    if (this.tauriUnlisten) {
      this.tauriUnlisten();
      this.tauriUnlisten = null;
    }
    if (isTauriRuntime()) {
      disconnectMidiInput().catch(() => {});
    }
    if (this.access) {
      this.access.inputs.forEach((port) => {
        port.onmidimessage = null;
      });
      this.access.onstatechange = null;
      this.access = null;
    }
  }
}
