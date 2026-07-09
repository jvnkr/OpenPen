import React, { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  ArrowUpRight,
  Camera,
  CircleCheck,
  Circle,
  CornerUpRight,
  Download,
  Eraser,
  Eye,
  Highlighter,
  ListX,
  Minus,
  MousePointer2,
  MousePointerClick,
  Move,
  PanelTop,
  Pen,
  Power,
  Presentation,
  Redo2,
  Settings,
  Square,
  Timer,
  Trash2,
  Type,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { applyDarkClass } from "@/lib/theme";
import { ColorPicker } from "./ColorPicker";
import { TOOLS as TOOL_DEFS, type Tool } from "@/tools";
import { DEFAULT_HOTKEYS, hotkeysForAction, type HotkeyAction, type HotkeyMap } from "@/hotkeys";
import type { Bg, HistoryState, ToolState } from "@/types";
import "@/styles/globals.css";

const clamp = (v: number, a: number, b: number): number =>
  Math.min(b, Math.max(a, v));

type Theme = "light" | "dark" | "system";

// Icons are a renderer-only concern, so they're mapped here rather than in the
// shared tool registry (which stays free of React/lucide so the main process
// could read it too).
const TOOL_ICONS: Record<Tool, LucideIcon> = {
  pen: Pen,
  drag: Move,
  highlighter: Highlighter,
  eraser: Eraser,
  text: Type,
  line: Minus,
  arrow: ArrowUpRight,
  curveArrow: CornerUpRight,
  rect: Square,
  ellipse: Circle,
};

function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

const SIZE_PRESETS = [
  { label: "Small", value: 3 },
  { label: "Medium", value: 6 },
  { label: "Large", value: 12 },
  { label: "Very large", value: 22 },
];

// Fade-time quick picks, in seconds.
const FADE_PRESETS = [1, 2, 5, 10];

interface SavedState extends Partial<ToolState> {
  theme?: Theme;
}

function loadSaved(): SavedState {
  try {
    return JSON.parse(localStorage.getItem("openpen") ?? "{}") as SavedState;
  } catch {
    return {};
  }
}

const TipSideContext = React.createContext<"left" | "right">("left");

function Tip({
  label,
  keys,
  children,
}: {
  label: string;
  keys?: string[];
  children: React.ReactElement;
}) {
  const side = React.useContext(TipSideContext);
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>
        <span className="inline-flex items-center gap-1.5">
          <span>{label}</span>
          {keys && keys.length > 0 && (
            <KbdGroup>
              {keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </KbdGroup>
          )}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

function ScreenshotTip({
  label,
  keys,
  success,
  onSuccessDone,
  children,
}: {
  label: string;
  keys?: string[];
  success: string | null;
  onSuccessDone: () => void;
  children: React.ReactElement;
}) {
  const side = React.useContext(TipSideContext);
  const clearSuccess = useRef(onSuccessDone);
  clearSuccess.current = onSuccessDone;

  useEffect(() => {
    if (!success) return;
    const timer = window.setTimeout(() => clearSuccess.current(), 2500);
    return () => window.clearTimeout(timer);
  }, [success]);

  if (success) {
    return (
      <Tooltip open>
        <TooltipTrigger render={children} />
        <TooltipContent side={side}>
          <span className="inline-flex items-center gap-1.5">
            <CircleCheck className="size-3.5 shrink-0" />
            <span>{success}</span>
          </span>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tip label={label} keys={keys}>
      {children}
    </Tip>
  );
}

function SizeDot({ value, className }: { value: number; className?: string }) {
  const dot = Math.max(4, Math.min(14, value * 0.6));
  // Render at a fixed 14px box and scale with a transform so cycling the brush
  // size grows/shrinks the dot on the GPU (no layout), making the control read
  // as "this is your size" rather than snapping between presets.
  return (
    <span
      className={cn(
        "rounded-full bg-current transition-transform duration-200 ease-out",
        className,
      )}
      style={{ width: 14, height: 14, transform: `scale(${dot / 14})` }}
    />
  );
}

export default function Toolbar(): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const saved = useRef(loadSaved()).current;
  const [tool, setTool] = useState<Tool>(saved.tool ?? "pen");
  const [color, setColor] = useState(saved.color ?? "#ff3b30");
  // Bumped when colour arrives from the screen eyedropper so HexColorInput
  // remounts with the new value (its internal field can lag the prop). Do not
  // remount the whole ColorPicker: that restarts the popover zoom and makes the
  // saturation pointer look like it slides from the old colour.
  const [hexEpoch, setHexEpoch] = useState(0);
  const [size, setSize] = useState(saved.size ?? 6);
  const [fade, setFade] = useState(saved.fade ?? false);
  const [fadeMs, setFadeMs] = useState(saved.fadeMs ?? 2000);
  const [theme, setTheme] = useState<Theme>(saved.theme ?? "system");
  const [mode, setMode] = useState(false);
  const [highlight, setHighlight] = useState(false);
  const [bg, setBg] = useState<Bg>("none");
  const [, setHidden] = useState(false);
  const [hist, setHist] = useState<HistoryState>({
    canUndo: false,
    canRedo: false,
    clearable: false,
  });
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [hotkeys, setHotkeys] = useState<HotkeyMap>(DEFAULT_HOTKEYS);
  const [screenshotting, setScreenshotting] = useState(false);
  const [screenshotSuccess, setScreenshotSuccess] = useState<string | null>(null);
  const [sizeOpen, setSizeOpen] = useState(false);
  const [fadeOpen, setFadeOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [tipSide, setTipSide] = useState<"left" | "right">("left");
  const overPanel = useRef(false);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
    suppressClick: boolean;
  } | null>(null);

  useEffect(() => {
    const offs = [
      window.openpen.on("mode", setMode),
      window.openpen.on("highlight", setHighlight),
      window.openpen.on("bg", setBg),
      window.openpen.on("hidden", setHidden),
      window.openpen.on("history", setHist),
      window.openpen.on("pick-tool", (t) => {
        if (t === "mouse") {
          window.openpen.send("set-highlight", false);
          window.openpen.send("set-mode", false);
        } else {
          setTool(t);
          window.openpen.send("set-mode", true);
        }
      }),
      window.openpen.on("adjust-size", (d) =>
        setSize((s) => clamp(s + d, 1, 48)),
      ),
      window.openpen.on("screenshotting", setScreenshotting),
      window.openpen.on("screenshot-saved", setScreenshotSuccess),
      window.openpen.on("tooltip-side", setTipSide),
      window.openpen.on("set-theme", setTheme),
      // Apply the resolved theme when the main process broadcasts it — the same
      // signal every window applies on, so all their view-transition crossfades
      // start together instead of the toolbar lagging the settings window.
      window.openpen.on("theme", (t) => applyDarkClass(t === "dark")),
      // Drawing on the canvas closes any open toolbar menu (brush/fade/color),
      // since a click out there can't reach this window's outside-press listener.
      window.openpen.on("close-menus", () => {
        setSizeOpen(false);
        setFadeOpen(false);
        setColorOpen(false);
        overPanel.current = false;
        window.openpen.send("toolbar-interactive", false);
      }),
      // Screen eyedropper result while the toolbar is still faded. Commit the
      // colour synchronously so the picker pointer is already at the new spot
      // before main restores opacity (no visible slide).
      window.openpen.on("set-color", (hex) => {
        flushSync(() => {
          setColor(hex);
          setHexEpoch((n) => n + 1);
        });
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            window.openpen.send("color-ready");
          });
        });
      }),
      window.openpen.on("update-badge", (s) => setUpdateAvailable(s.available)),
      window.openpen.on("hotkeys", setHotkeys),
    ];
    window.openpen.send("toolbar-ready");
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    window.openpen.send("tool-state", { tool, color, size, fade, fadeMs });
  }, [tool, color, size, fade, fadeMs]);

  useEffect(() => {
    const apply = (): void => {
      // Only resolve + publish the theme here; the actual class toggle happens
      // in the 'theme' broadcast handler above, so the toolbar animates in step
      // with the picker and settings windows.
      window.openpen.send("theme", resolveTheme(theme));
    };
    apply();
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("openpen", JSON.stringify({ tool, color, size, fade, fadeMs, theme }));
  }, [tool, color, size, fade, fadeMs, theme]);

  useEffect(() => {
    const fit = (): void => {
      const panel = panelRef.current;
      if (!panel) return;
      window.openpen.send("toolbar-fit-height", panel.scrollHeight + 2);
    };
    fit();
    const panel = panelRef.current;
    if (!panel) return;
    const observer = new ResizeObserver(fit);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  const pickTool = (t: Tool): void => {
    setTool(t);
    window.openpen.send("set-mode", true);
  };
  const cmd = (name: string): void => window.openpen.send("cmd", name);
  // The toolbar window is click-through in its transparent gutter; keep it
  // interactive whenever the pointer is over the panel OR the size popover is
  // open, so the popover (which lives in the gutter) stays clickable.
  const syncInteractive = (open: boolean): void =>
    window.openpen.send("toolbar-interactive", open || overPanel.current);

  const pointerPoint = (
    e: React.PointerEvent<HTMLElement>,
  ): { x: number; y: number } => ({ x: e.screenX, y: e.screenY });
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    // A popover's slider is portaled to the window body, so a press on it never
    // reaches this handler — but never arm a toolbar drag while one is open, so
    // dragging the slider can't turn into dragging the whole toolbar.
    if (e.button !== 0 || sizeOpen || fadeOpen || colorOpen) return;
    drag.current = {
      pointerId: e.pointerId,
      startX: e.screenX,
      startY: e.screenY,
      dragging: false,
      suppressClick: false,
    };
  };
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (sizeOpen || fadeOpen || colorOpen) return;
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.screenX - d.startX;
    const dy = e.screenY - d.startY;
    if (!d.dragging && Math.hypot(dx, dy) < 4) return;
    if (!d.dragging) {
      d.dragging = true;
      d.suppressClick = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      window.openpen.send("toolbar-drag-start", { x: d.startX, y: d.startY });
    }
    e.preventDefault();
    window.openpen.send("toolbar-drag-move", pointerPoint(e));
  };
  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (d.dragging) window.openpen.send("toolbar-drag-end");
    drag.current = d.suppressClick ? { ...d, dragging: false } : null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };
  const handleClickCapture = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!drag.current?.suppressClick) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = null;
  };

  const hk = (action: HotkeyAction): string[] | undefined => hotkeysForAction(hotkeys, action);
  const toolHk = (tool: Tool): string[] | undefined => hotkeysForAction(hotkeys, `tool:${tool}`);

  return (
    <TooltipProvider>
      <TipSideContext.Provider value={tipSide}>
      <div className="flex w-full justify-center">
        <div
          ref={panelRef}
          className={cn(
            "flex h-fit w-12 flex-col gap-0.5 overflow-hidden rounded-md border bg-background/95 p-1 shadow-lg shadow-black/10",
            "[&_button]:focus-visible:border-transparent [&_button]:focus-visible:ring-0 [&_button]:focus-visible:ring-offset-0",
            screenshotting && "border-transparent shadow-none",
          )}
          onMouseEnter={() => {
            overPanel.current = true;
            window.openpen.send("toolbar-interactive", true);
          }}
          onMouseLeave={() => {
            overPanel.current = false;
            syncInteractive(sizeOpen || fadeOpen || colorOpen);
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onClickCapture={handleClickCapture}
        >
          <Tip label="Hide toolbar" keys={hk("toggleToolbar")}>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-full shrink-0 rounded-sm [&_svg]:size-3.5"
              aria-label="Hide toolbar"
              onClick={() => window.openpen.send("toggle-toolbar")}
            >
              <Eye />
            </Button>
          </Tip>

          <Separator className="my-0.5 shrink-0" />

          <Tip label="Mouse mode" keys={hk("mouseMode")}>
            <Button
              variant={!mode && !highlight ? "default" : "ghost"}
              size="icon"
              className="h-7 w-full shrink-0 rounded-sm [&_svg]:size-3.5"
              aria-label="Mouse mode"
              onClick={() => {
                window.openpen.send("set-highlight", false);
                window.openpen.send("set-mode", false);
              }}
            >
              <MousePointer2 />
            </Button>
          </Tip>

          <Tip label="Highlight cursor" keys={hk("highlightCursor")}>
            <Button
              variant={highlight ? "default" : "ghost"}
              size="icon"
              className="h-7 w-full shrink-0 rounded-sm [&_svg]:size-3.5"
              aria-label="Highlight cursor"
              aria-pressed={highlight}
              onClick={() => window.openpen.send("set-highlight", true)}
            >
              <MousePointerClick />
            </Button>
          </Tip>

          <div className="flex shrink-0 flex-col gap-0.5">
            {TOOL_DEFS.map(({ id, name }) => {
              const Icon = TOOL_ICONS[id];
              return (
                <Tip
                  key={id}
                  label={name}
                  keys={toolHk(id)}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={name}
                    className={cn(
                      "h-7 w-full rounded-sm px-0 [&_svg]:size-3.5",
                      mode &&
                        tool === id &&
                        !screenshotting &&
                        "bg-accent text-accent-foreground",
                    )}
                    onClick={() => pickTool(id)}
                  >
                    <Icon />
                  </Button>
                </Tip>
              );
            })}
          </div>

          <Separator className="my-0.5 shrink-0" />

          <Popover
            open={sizeOpen}
            onOpenChange={(open) => {
              setSizeOpen(open);
              syncInteractive(open);
            }}
          >
            <PopoverTrigger
              aria-label="Brush size"
              className={cn(
                "flex h-7 w-full shrink-0 cursor-pointer items-center justify-center rounded-sm border bg-secondary/70 transition-colors duration-150 ease-out hover:bg-accent",
                sizeOpen && !screenshotting && "bg-accent",
              )}
            >
              <SizeDot value={size} />
            </PopoverTrigger>
            <PopoverContent
              side={tipSide}
              sideOffset={8}
              className="w-48"
              aria-label="Brush size"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  Brush size
                </span>
                <span className="text-xs tabular-nums text-foreground">
                  {size}px
                </span>
              </div>
              <div className="mt-2.5 flex items-center gap-2.5">
                <SizeDot value={4} className="opacity-60" />
                <Slider
                  min={1}
                  max={48}
                  value={[size]}
                  onValueChange={(v) =>
                    setSize(Array.isArray(v) ? (v[0] ?? size) : v)
                  }
                  aria-label="Brush size"
                  className="flex-1"
                />
                <SizeDot value={20} className="opacity-60" />
              </div>
              <div className="mt-3 grid grid-cols-4 gap-1">
                {SIZE_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    aria-label={preset.label}
                    aria-pressed={size === preset.value}
                    className={cn(
                      "flex h-9 flex-col items-center justify-center gap-1 rounded-md border text-[0.65rem] transition-colors duration-150 ease-out",
                      size === preset.value
                        ? "border-transparent bg-accent text-accent-foreground"
                        : "border-border bg-secondary/50 text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                    onClick={() => {
                      setSize(preset.value);
                      setSizeOpen(false);
                      syncInteractive(false);
                    }}
                  >
                    <SizeDot value={preset.value} />
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          <Popover
            open={colorOpen}
            onOpenChange={(open) => {
              setColorOpen(open);
              syncInteractive(open);
            }}
          >
            <PopoverTrigger
              aria-label="Custom color"
              className={cn(
                "h-7 w-full shrink-0 cursor-pointer rounded-sm border border-border transition-[border-color] duration-150 ease-out hover:border-foreground/40",
                colorOpen && !screenshotting && "border-foreground/50",
              )}
              style={{ background: color }}
            />
            <PopoverContent
              side={tipSide}
              sideOffset={8}
              className="w-48"
              aria-label="Custom color"
            >
              <ColorPicker
                color={color}
                hexKey={hexEpoch}
                onChange={setColor}
                onEyedrop={() => window.openpen.send("eyedrop-start")}
              />
            </PopoverContent>
          </Popover>

          <Popover
            open={fadeOpen}
            onOpenChange={(open) => {
              setFadeOpen(open);
              syncInteractive(open);
            }}
          >
            <PopoverTrigger
              aria-label="Fading ink"
              className={cn(
                "flex h-7 w-full shrink-0 cursor-pointer items-center justify-center rounded-sm transition-colors duration-150 ease-out [&_svg]:size-3.5",
                fade && !screenshotting
                  ? "bg-primary text-primary-foreground"
                  : "text-foreground hover:bg-muted",
              )}
            >
              <Timer />
            </PopoverTrigger>
            <PopoverContent
              side={tipSide}
              sideOffset={8}
              className="w-48"
              aria-label="Fading ink"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground">
                  Fading ink
                </span>
                <button
                  role="switch"
                  aria-checked={fade}
                  aria-label="Toggle fading ink"
                  onClick={() => setFade((f) => !f)}
                  className={cn(
                    "relative h-4 w-7 shrink-0 cursor-pointer rounded-full transition-colors duration-150 ease-out",
                    fade ? "bg-primary" : "bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 size-3 rounded-full bg-white shadow-sm transition-[left] duration-150 ease-out",
                      fade ? "left-3.5" : "left-0.5",
                    )}
                  />
                </button>
              </div>
              <div
                className={cn(
                  "mt-3 transition-opacity duration-150",
                  !fade && "opacity-50",
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Fade time</span>
                  <span className="text-xs tabular-nums text-foreground">
                    {(fadeMs / 1000).toFixed(1)}s
                  </span>
                </div>
                <Slider
                  min={0.5}
                  max={10}
                  step={0.1}
                  value={[fadeMs / 1000]}
                  onValueChange={(v) =>
                    setFadeMs(
                      Math.round((Array.isArray(v) ? (v[0] ?? 2) : v) * 1000),
                    )
                  }
                  aria-label="Fade time"
                  className="mt-2"
                />
                <div className="mt-3 grid grid-cols-4 gap-1">
                  {FADE_PRESETS.map((sec) => (
                    <button
                      key={sec}
                      aria-label={`${sec} seconds`}
                      aria-pressed={fadeMs === sec * 1000}
                      className={cn(
                        "h-7 rounded-md border text-xs tabular-nums transition-colors duration-150 ease-out",
                        fadeMs === sec * 1000
                          ? "border-transparent bg-accent text-accent-foreground"
                          : "border-border bg-secondary/50 text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                      )}
                      onClick={() => setFadeMs(sec * 1000)}
                    >
                      {sec}s
                    </button>
                  ))}
                </div>
              </div>
            </PopoverContent>
          </Popover>

          <Separator className="my-0.5 shrink-0" />

          <div className="flex shrink-0 flex-col gap-0.5">
            <Tip label="Whiteboard" keys={hk("whiteboard")}>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Whiteboard"
                aria-pressed={bg === "white"}
                className={cn(
                  "h-7 w-full rounded-sm px-0 [&_svg]:size-3.5",
                  bg === "white" &&
                    !screenshotting &&
                    "bg-accent text-accent-foreground",
                )}
                onClick={() => window.openpen.send("set-bg", "white")}
              >
                <Presentation />
              </Button>
            </Tip>
            <Tip label="Blackboard" keys={hk("blackboard")}>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Blackboard"
                aria-pressed={bg === "black"}
                className={cn(
                  "h-7 w-full rounded-sm px-0 [&_svg]:size-3.5",
                  bg === "black" &&
                    !screenshotting &&
                    "bg-accent text-accent-foreground",
                )}
                onClick={() => window.openpen.send("set-bg", "black")}
              >
                <PanelTop />
              </Button>
            </Tip>
          </div>

          <Separator className="my-0.5 shrink-0" />

          <div className="flex shrink-0 flex-col gap-0.5">
            <Tip label="Undo" keys={hk("undo")}>
              <Button
                variant="ghost"
                className="h-7 w-full rounded-sm px-0 [&_svg]:size-3.5"
                disabled={!hist.canUndo}
                aria-label="Undo"
                onClick={() => cmd("undo")}
              >
                <Undo2 />
              </Button>
            </Tip>
            <Tip label="Redo" keys={hk("redo")}>
              <Button
                variant="ghost"
                className="h-7 w-full rounded-sm px-0 [&_svg]:size-3.5"
                disabled={!hist.canRedo}
                aria-label="Redo"
                onClick={() => cmd("redo")}
              >
                <Redo2 />
              </Button>
            </Tip>
            <Tip label="Clear screen" keys={hk("clear")}>
              <Button
                variant="destructive"
                className="h-7 w-full rounded-sm px-0 [&_svg]:size-3.5"
                disabled={!hist.clearable}
                aria-label="Clear screen"
                onClick={() => cmd("clear")}
              >
                <Trash2 />
              </Button>
            </Tip>
            <Tip label="Clear undo history">
              <Button
                variant="ghost"
                className="h-7 w-full rounded-sm px-0 [&_svg]:size-3.5"
                disabled={!hist.canUndo && !hist.canRedo}
                aria-label="Clear undo history"
                onClick={() => cmd("reset-history")}
              >
                <ListX />
              </Button>
            </Tip>
            <ScreenshotTip
              label="Save screenshot"
              keys={hk("screenshot")}
              success={screenshotSuccess}
              onSuccessDone={() => setScreenshotSuccess(null)}
            >
              <Button
                variant="ghost"
                className="h-7 w-full rounded-sm px-0 [&_svg]:size-3.5"
                aria-label="Save screenshot"
                onClick={() => window.openpen.send("screenshot")}
              >
                <Camera />
              </Button>
            </ScreenshotTip>
            <Tip label="Export annotations">
              <Button
                variant="ghost"
                className="h-7 w-full rounded-sm px-0 [&_svg]:size-3.5"
                aria-label="Export annotations"
                onClick={() => window.openpen.send("export")}
              >
                <Download />
              </Button>
            </Tip>
          </div>

          <Separator className="my-0.5 shrink-0" />

          <Tip label={updateAvailable ? "Settings (update available)" : "Settings"}>
            <Button
              variant="ghost"
              size="icon"
              className="relative h-7 w-full shrink-0 rounded-sm [&_svg]:size-3.5"
              aria-label={updateAvailable ? "Settings, update available" : "Settings"}
              onClick={() => window.openpen.send("open-settings")}
            >
              <Settings />
              {updateAvailable && (
                <span
                  className="pointer-events-none absolute top-0.5 right-0.5 size-2 rounded-full bg-red-500 ring-2 ring-background"
                  aria-hidden
                />
              )}
            </Button>
          </Tip>
          <Tip label="Quit OpenPen">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-full shrink-0 rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive [&_svg]:size-3.5"
              aria-label="Quit OpenPen"
              onClick={() => window.openpen.send("quit")}
            >
              <Power />
            </Button>
          </Tip>
        </div>
      </div>
      </TipSideContext.Provider>
    </TooltipProvider>
  );
}
