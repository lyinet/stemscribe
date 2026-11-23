use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{App, AppHandle, Emitter, Runtime};
use std::sync::Mutex;

/// Current UI language for native menu labels ("zh" default, "en" supported).
static MENU_LANGUAGE: Mutex<String> = Mutex::new(String::new());

/// (zh, en) for every user-visible menu label, in declaration order.
struct L(&'static str, &'static str);
impl L {
    fn get(&self, lang: &str) -> &'static str {
        if lang == "en" { self.1 } else { self.0 }
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, lang: &str) -> tauri::Result<()> {
    let g = |l: L| l.get(lang);

    let open_settings = MenuItemBuilder::with_id("open_settings", g(L("设置...", "Settings...")))
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "StemScribe")
        .item(&PredefinedMenuItem::about(app, Some(g(L("关于 StemScribe", "About StemScribe"))), None)?)
        .separator()
        .item(&open_settings)
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some(g(L("隐藏 StemScribe", "Hide StemScribe"))))?)
        .item(&PredefinedMenuItem::hide_others(app, Some(g(L("隐藏其他", "Hide Others"))))?)
        .item(&PredefinedMenuItem::show_all(app, Some(g(L("全部显示", "Show All"))))?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some(g(L("退出 StemScribe", "Quit StemScribe"))))?)
        .build()?;

    let open_audio = MenuItemBuilder::with_id("open_audio", g(L("导入音频...", "Import Audio...")))
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let import_midi = MenuItemBuilder::with_id("import_midi", g(L("导入 MIDI 乐谱 (.mid)...", "Import MIDI Score (.mid)...")))
        .accelerator("CmdOrCtrl+I")
        .build(app)?;
    let import_stems = MenuItemBuilder::with_id("import_stems", g(L("导入分轨（Suno 等）...", "Import Stems (Suno etc.)...")))
        .build(app)?;
    let load_demo = MenuItemBuilder::with_id("load_demo_song", g(L("体验内置 4 轨演示曲", "Load Built-in 4-Stem Demo")))
        .accelerator("CmdOrCtrl+D")
        .build(app)?;
    let open_setlist = MenuItemBuilder::with_id("open_setlist", g(L("演出歌单 / Setlist...", "Setlist...")))
        .accelerator("CmdOrCtrl+L")
        .build(app)?;
    let open_batch = MenuItemBuilder::with_id("open_batch", g(L("批量分轨队列...", "Batch Separation Queue...")))
        .accelerator("CmdOrCtrl+B")
        .build(app)?;
    let save_project = MenuItemBuilder::with_id("save_project", g(L("保存工程", "Save Project")))
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let export_midi = MenuItemBuilder::with_id("export_midi", g(L("导出 MIDI (.mid)", "Export MIDI (.mid)")))
        .accelerator("CmdOrCtrl+E")
        .build(app)?;
    let export_wav = MenuItemBuilder::with_id("export_wav", g(L("导出混音伴奏 WAV...", "Export Backing Mix WAV...")))
        .build(app)?;
    let export_bundle = MenuItemBuilder::with_id("export_bundle", g(L("一键导出扒带资料包...", "Export Transcription Bundle...")))
        .accelerator("CmdOrCtrl+Shift+E")
        .build(app)?;
    let open_leadsheet = MenuItemBuilder::with_id("open_leadsheet", g(L("A4 弹唱和弦谱排版 / 打印...", "A4 Lead Sheet Layout / Print...")))
        .accelerator("CmdOrCtrl+P")
        .build(app)?;
    let open_share = MenuItemBuilder::with_id("open_share_card", g(L("生成扒带/练琴分享卡片...", "Generate Share Card...")))
        .build(app)?;

    let file_menu = SubmenuBuilder::new(app, g(L("文件", "File")))
        .item(&open_audio)
        .item(&import_stems)
        .item(&import_midi)
        .item(&load_demo)
        .item(&open_setlist)
        .item(&open_batch)
        .separator()
        .item(&save_project)
        .item(&export_midi)
        .item(&export_wav)
        .item(&export_bundle)
        .item(&open_leadsheet)
        .item(&open_share)
        .build()?;

    let undo = MenuItemBuilder::with_id("undo", g(L("撤销修音", "Undo Edit")))
        .accelerator("CmdOrCtrl+Z")
        .build(app)?;
    let redo = MenuItemBuilder::with_id("redo", g(L("重做修音", "Redo Edit")))
        .accelerator("CmdOrCtrl+Shift+Z")
        .build(app)?;
    let quantize = MenuItemBuilder::with_id("quantize", g(L("1/16 拍节奏量化", "Quantize to 1/16")))
        .accelerator("CmdOrCtrl+U")
        .build(app)?;

    let edit_menu = SubmenuBuilder::new(app, g(L("编辑", "Edit")))
        .item(&undo)
        .item(&redo)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some(g(L("剪切", "Cut"))))?)
        .item(&PredefinedMenuItem::copy(app, Some(g(L("拷贝", "Copy"))))?)
        .item(&PredefinedMenuItem::paste(app, Some(g(L("粘贴", "Paste"))))?)
        .item(&PredefinedMenuItem::select_all(app, Some(g(L("全选", "Select All"))))?)
        .separator()
        .item(&quantize)
        .build()?;

    let toggle_play = MenuItemBuilder::with_id("toggle_play", g(L("播放 / 暂停", "Play / Pause"))).build(app)?;
    let toggle_metro = MenuItemBuilder::with_id("toggle_metronome", g(L("开关节拍器", "Toggle Metronome"))).build(app)?;
    let toggle_loop = MenuItemBuilder::with_id("toggle_loop", g(L("开关 A-B 循环", "Toggle A-B Loop"))).build(app)?;
    let toggle_stage = MenuItemBuilder::with_id("toggle_stage_mode", g(L("全屏演出提词模式", "Fullscreen Stage Mode")))
        .accelerator("CmdOrCtrl+Shift+F")
        .build(app)?;

    let playback_menu = SubmenuBuilder::new(app, g(L("播放", "Playback")))
        .item(&toggle_play)
        .item(&toggle_metro)
        .item(&toggle_loop)
        .separator()
        .item(&toggle_stage)
        .build()?;

    let restore_audio = MenuItemBuilder::with_id("restore_audio", g(L("一键修复音质...", "One-Click Restore...")))
        .accelerator("CmdOrCtrl+R")
        .build(app)?;
    let open_palette = MenuItemBuilder::with_id("open_command_palette", g(L("全局快捷命令面板...", "Command Palette...")))
        .accelerator("CmdOrCtrl+K")
        .build(app)?;
    let model_manager = MenuItemBuilder::with_id("open_models", g(L("本地 ONNX 模型管理器...", "Local ONNX Model Manager...")))
        .build(app)?;
    let tools_menu = SubmenuBuilder::new(app, g(L("工具", "Tools")))
        .item(&restore_audio)
        .separator()
        .item(&open_palette)
        .item(&model_manager)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, g(L("窗口", "Window")))
        .item(&PredefinedMenuItem::minimize(app, Some(g(L("最小化", "Minimize"))))?)
        .item(&PredefinedMenuItem::fullscreen(app, Some(g(L("进入全屏", "Enter Full Screen"))))?)
        .build()?;

    let menu: Menu<R> = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&playback_menu)
        .item(&tools_menu)
        .item(&window_menu)
        .build()?;

    app.set_menu(menu)?;

    Ok(())
}

/// Rebuild the native menu with a different UI language. Menu ids are unchanged.
#[tauri::command]
pub fn set_menu_language<R: Runtime>(app: AppHandle<R>, lang: String) -> Result<(), String> {
    let lang = if lang == "en" { "en".to_string() } else { "zh".to_string() };
    *MENU_LANGUAGE.lock().map_err(|e| e.to_string())? = lang.clone();
    build_menu(&app, &lang).map_err(|e| e.to_string())
}

pub fn setup_macos_menu<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let lang = MENU_LANGUAGE
        .lock()
        .map(|l| l.clone())
        .unwrap_or_else(|_| "zh".to_string());
    let lang = if lang.is_empty() { "zh".to_string() } else { lang };
    build_menu(&app.handle().clone(), &lang)?;

    app.on_menu_event(|app_handle, event| {
        let action_id = event.id().as_ref().to_string();
        let _ = app_handle.emit("menu-action", action_id);
    });

    Ok(())
}
