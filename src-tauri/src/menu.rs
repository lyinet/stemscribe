use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{App, Emitter, Runtime};

pub fn setup_macos_menu<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let open_audio = MenuItemBuilder::with_id("open_audio", "导入音频...")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let import_midi = MenuItemBuilder::with_id("import_midi", "导入 MIDI 乐谱 (.mid)...")
        .accelerator("CmdOrCtrl+I")
        .build(app)?;
    let load_demo = MenuItemBuilder::with_id("load_demo_song", "体验内置 4 轨演示曲")
        .accelerator("CmdOrCtrl+D")
        .build(app)?;
    let open_setlist = MenuItemBuilder::with_id("open_setlist", "演出歌单 / Setlist...")
        .accelerator("CmdOrCtrl+L")
        .build(app)?;
    let open_batch = MenuItemBuilder::with_id("open_batch", "批量分轨队列...")
        .accelerator("CmdOrCtrl+B")
        .build(app)?;
    let save_project = MenuItemBuilder::with_id("save_project", "保存工程")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let export_midi = MenuItemBuilder::with_id("export_midi", "导出 MIDI (.mid)")
        .accelerator("CmdOrCtrl+E")
        .build(app)?;
    let export_wav = MenuItemBuilder::with_id("export_wav", "导出混音伴奏 WAV...")
        .build(app)?;
    let export_bundle = MenuItemBuilder::with_id("export_bundle", "一键导出扒带资料包...")
        .accelerator("CmdOrCtrl+Shift+E")
        .build(app)?;
    let open_leadsheet = MenuItemBuilder::with_id("open_leadsheet", "A4 弹唱和弦谱排版 / 打印...")
        .accelerator("CmdOrCtrl+P")
        .build(app)?;
    let open_share = MenuItemBuilder::with_id("open_share_card", "生成扒带/练琴分享卡片...")
        .build(app)?;

    let file_menu = SubmenuBuilder::new(app, "文件")
        .item(&open_audio)
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

    let undo = MenuItemBuilder::with_id("undo", "撤销修音")
        .accelerator("CmdOrCtrl+Z")
        .build(app)?;
    let redo = MenuItemBuilder::with_id("redo", "重做修音")
        .accelerator("CmdOrCtrl+Shift+Z")
        .build(app)?;
    let quantize = MenuItemBuilder::with_id("quantize", "1/16 拍节奏量化")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .item(&undo)
        .item(&redo)
        .separator()
        .item(&quantize)
        .build()?;

    let toggle_play = MenuItemBuilder::with_id("toggle_play", "播放 / 暂停").build(app)?;
    let toggle_metro = MenuItemBuilder::with_id("toggle_metronome", "开关节拍器").build(app)?;
    let toggle_loop = MenuItemBuilder::with_id("toggle_loop", "开关 A-B 循环").build(app)?;
    let toggle_stage = MenuItemBuilder::with_id("toggle_stage_mode", "全屏演出提词模式")
        .accelerator("CmdOrCtrl+Shift+F")
        .build(app)?;

    let playback_menu = SubmenuBuilder::new(app, "播放")
        .item(&toggle_play)
        .item(&toggle_metro)
        .item(&toggle_loop)
        .separator()
        .item(&toggle_stage)
        .build()?;

    let open_palette = MenuItemBuilder::with_id("open_command_palette", "全局快捷命令面板...")
        .accelerator("CmdOrCtrl+K")
        .build(app)?;
    let model_manager = MenuItemBuilder::with_id("open_models", "本地 ONNX 模型管理器...")
        .build(app)?;
    let tools_menu = SubmenuBuilder::new(app, "工具")
        .item(&open_palette)
        .separator()
        .item(&model_manager)
        .build()?;

    let menu: Menu<R> = MenuBuilder::new(app)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&playback_menu)
        .item(&tools_menu)
        .build()?;

    app.set_menu(menu)?;

    app.on_menu_event(|app_handle, event| {
        let action_id = event.id().as_ref().to_string();
        let _ = app_handle.emit("menu-action", action_id);
    });

    Ok(())
}
