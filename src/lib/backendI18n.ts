// Localize user-visible strings returned by the Rust backend (src-tauri/src/audio/**).
// Backend message ids are stable (`Issue.id`); free-text notes are left untranslated.
import { t } from "../i18n";

export interface BackendIssue {
  id: string;
  severity: "ok" | "warn" | "bad";
  title: string;
  detail: string;
}

const num = /([\d.]+)/;

/** Translate a backend issue's title/detail by id; unknown ids pass through unchanged. */
export function translateIssue(iss: BackendIssue): BackendIssue {
  if (iss.id === "hf_cutoff") {
    const c = iss.title.match(/([\d.]+)\s*kHz/)?.[1] ?? "";
    const d = iss.detail.match(/参考电平\s*([+-]?[\d.]+)/)?.[1] ?? "";
    return { ...iss, title: t("be.hfCutoff.title", { cut: c }), detail: t("be.hfCutoff.detail", { refDb: d, cut: c }) };
  }
  if (iss.id === "low_mid_excess") {
    const m = iss.title.match(/\+(\d+)\s*dB（约\s*([\d.]+)/) ?? iss.title.match(/([\d.]+).*?([\d.]+)/);
    return { ...iss, title: t("be.lowMid.title", { db: m?.[1] ?? "", hz: m?.[2] ?? "" }), detail: t("be.lowMid.detail") };
  }
  if (iss.id === "harsh_peaks") {
    const m = iss.title.match(/([\d.]+)\s*kHz\s*\+([\d.]+)/);
    return { ...iss, title: t("be.harsh.title", { hz: m?.[1] ?? "", db: m?.[2] ?? "" }), detail: iss.detail };
  }
  if (iss.id === "mono") {
    return { ...iss, title: t("be.mono.title"), detail: t("be.mono.detail") };
  }
  if (iss.id === "low_band_corr") {
    const c = iss.detail.match(/相关性\s*([\d.]+)/)?.[1] ?? "";
    return { ...iss, title: t("be.lowCorr.title"), detail: t("be.lowCorr.detail", { corr: c }) };
  }
  if (iss.id === "clipping") {
    const n = num.exec(iss.title)?.[1] ?? "";
    return { ...iss, title: t("be.clipping.title", { n }), detail: t("be.clipping.detail") };
  }
  if (iss.id === "dc_offset") {
    const m = iss.detail.match(/([+-][\d.]+)\s*\/\s*R\s*([+-][\d.]+)/);
    return { ...iss, title: t("be.dcOffset.title"), detail: t("be.dcOffset.detail", { l: m?.[1] ?? "", r: m?.[2] ?? "" }) };
  }
  if (iss.id === "true_peak") {
    const p = iss.title.match(/([+-]?[\d.]+)\s*dBTP/)?.[1] ?? "";
    return { ...iss, title: t("be.truePeak.title", { tp: p }), detail: t("be.truePeak.detail") };
  }
  if (iss.id === "lra_flat") {
    const l = iss.title.match(/([\d.]+)\s*LU/)?.[1] ?? "";
    return { ...iss, title: t("be.lra.title", { lra: l }), detail: t("be.lra.detail") };
  }
  return iss;
}
