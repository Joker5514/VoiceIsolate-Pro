# Workspace layout

Stems and Engineer share one presentation shell. Web, the Capacitor Android
WebView, and Electron all load the files `pnpm build` copies from `public/`
and `src/` into `build/`. There is not a second Android or Desktop UI.

`src/presentation/WorkspaceBlocks.js` adds resize grips, collapse, maximize,
and reorder to the blocks listed in `BLOCKS`. `public/workspace-blocks.css`
is the shared sheet. Layout records live in `localStorage` under
`vip-workspace-layouts`, separate from the rack sizes in `vip-panel-sizes`.

Resizing sets CSS on the block. It does not start workers, decode audio, or
call Process.

## What persists

Each mode stores its own blocks:

- height and width
- collapsed and maximized
- order, where the parent is a flex or grid and the block is marked reorderable
- the size from before maximize, so Restore can return to it

A bad version, broken JSON, or a non-numeric size is ignored. The block stays
at its stylesheet size.

Reset layout clears the mode on screen. The other mode is left as saved.
Double-click a grip clears that axis. Reload and a new app launch read the
same record because it is `localStorage`.

## Platform exceptions

- Shipped separation is a voice stem and a residual background. Drum, bass,
  and other stem cards are not in the product. Demucs stays unshipped.
- The rack column width is still the shared `--vip-rack-w` grip from
  `PanelResize.js`. Workspace layout does not write that key.
- Stage and inspector column widths apply at 1280px and wider. Narrower
  windows, including Android portrait, keep height, collapse, and maximize.
  A saved width is kept and applied again when the window is wide enough.
  The neural Engineer skin places the inspector on the left and the stage in
  the center. A saved stage width is written to that center track. The rack
  track stays `--vip-rack-w`.
- Touch pointers (`pointer: coarse`) get 44px grips and always-visible
  block actions. Width grips stay hidden under 1280px so a stacked layout
  cannot be dragged sideways off the screen.
- Electron's window frame and Android's system bars are native. They are not
  workspace blocks.
- The accent family stays the pearlescent red in `design-tokens.css`. Near-black
  surfaces stay on `--vip-surface-*`. This sheet does not introduce a second
  palette.
- iOS is out of scope.
- Reorder is skipped when a block is the only reorderable child of its parent,
  and when an explicit grid line already places it (the stem lane grid).
- The Engineer signal-chain list (`#vipSignalChain`) is folded into the
  processing explanation and then hidden. The resizable block is
  `#section-processing`. A grip is not attached to the hidden list.

## Comparison

The parity test checks that both HTML shells link this sheet and the shared
tokens, that Android's `webDir` and Electron's `vip://app/index.html` consume
the same `build/`, and that the block catalog covers the shell, Stems,
Engineer, upload, waveform, mixer, signal chain, Forensic Inspector,
diagnostics, export, and settings. Behavior is covered in
`tests/workspace-blocks.test.js`. A pixel diff of three renderers would
compare one DOM, so the check is structural and functional.
