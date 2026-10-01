import {
  BrowserWindow, screen, shell, ipcMain,
} from 'electron';
import { join } from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { is } from '@electron-toolkit/utils';

const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

// Linux ignores the `forward` option of setIgnoreMouseEvents
// (electron/electron#16777, open since 2019), so mouse-move events never reach
// the renderer while the pet window is click-through. Without them the hover
// hit-test never fires and the window stays click-through forever.
// Work around it by polling the cursor from the main process, which can read
// the pointer regardless of the window's mouse-ignore state, and letting the
// renderer hit-test that point instead.
const CURSOR_PROBE_INTERVAL_MS = 50;

// Streams "<x> <y>" lines to stdout whenever the pointer moves, read straight
// from the X server so the click-through state of our window is irrelevant.
// Kept inline rather than shipped as a file so it survives asar packaging.
const X11_POINTER_SCRIPT = `
import ctypes, sys, time
X = ctypes.CDLL('libX11.so.6')
X.XOpenDisplay.restype = ctypes.c_void_p
display = X.XOpenDisplay(None)
if not display:
    sys.exit(1)
X.XDefaultRootWindow.restype = ctypes.c_ulong
X.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
root = X.XDefaultRootWindow(display)
root_ret = ctypes.c_ulong(); child_ret = ctypes.c_ulong()
rx = ctypes.c_int(); ry = ctypes.c_int()
wx = ctypes.c_int(); wy = ctypes.c_int()
mask = ctypes.c_uint()
X.XQueryPointer.argtypes = [
    ctypes.c_void_p, ctypes.c_ulong,
    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
    ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
    ctypes.POINTER(ctypes.c_uint)]
last = None
while True:
    X.XQueryPointer(display, root, root_ret, child_ret, rx, ry, wx, wy, mask)
    point = (rx.value, ry.value)
    if point != last:
        last = point
        sys.stdout.write('%d %d\\n' % point)
        sys.stdout.flush()
    time.sleep(0.03)
`;

// Set PET_DEBUG=1 to trace the pet-mode hover pipeline on stdout.
const PET_DEBUG = process.env.PET_DEBUG === '1';
const petLog = (...args: unknown[]): void => {
  if (PET_DEBUG) console.log('[pet]', ...args);
};

export class WindowManager {
  private window: BrowserWindow | null = null;

  private windowedBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null = null;

  private hoveringComponents: Set<string> = new Set();

  private currentMode: 'window' | 'pet' = 'window';

  // Track if mouse events are forcibly ignored
  private forceIgnoreMouse = false;

  // Linux-only: cursor tracking while in pet mode
  private cursorProbeTimer: NodeJS.Timeout | null = null;

  private pointerProc: ChildProcessWithoutNullStreams | null = null;

  constructor() {
    ipcMain.on('renderer-ready-for-mode-change', (_event, newMode) => {
      if (newMode === 'pet') {
        setTimeout(() => {
          this.continueSetWindowModePet();
        }, 500);
      } else {
        setTimeout(() => {
          this.continueSetWindowModeWindow();
        }, 500);
      }
    });

    ipcMain.on('mode-change-rendered', () => {
      this.window?.setOpacity(1);
    });

    ipcMain.on('window-unfullscreen', () => {
      const window = this.getWindow();
      if (window && window.isFullScreen()) {
        window.setFullScreen(false);
      }
    });

    // Handle toggle force ignore mouse events from renderer
    ipcMain.on('toggle-force-ignore-mouse', () => {
      this.toggleForceIgnoreMouse();
    });
  }

  createWindow(options: Electron.BrowserWindowConstructorOptions): BrowserWindow {
    this.window = new BrowserWindow({
      width: 900,
      height: 670,
      show: false,
      transparent: true,
      backgroundColor: '#ffffff',
      autoHideMenuBar: true,
      frame: false,
      icon: process.platform === 'win32'
        ? join(__dirname, '../../resources/icon.ico')
        : join(__dirname, '../../resources/icon.png'),
      ...(isMac ? { titleBarStyle: 'hiddenInset' } : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: true,
      },
      hasShadow: false,
      paintWhenInitiallyHidden: true,
      ...options,
    });

    this.setupWindowEvents();
    this.loadContent();

    this.window.on('enter-full-screen', () => {
      this.window?.webContents.send('window-fullscreen-change', true);
    });

    this.window.on('leave-full-screen', () => {
      this.window?.webContents.send('window-fullscreen-change', false);
    });

    return this.window;
  }

  private setupWindowEvents(): void {
    if (!this.window) return;

    this.window.on('ready-to-show', () => {
      this.window?.show();
      this.window?.webContents.send(
        'window-maximized-change',
        this.window.isMaximized(),
      );
    });

    this.window.on('maximize', () => {
      this.window?.webContents.send('window-maximized-change', true);
    });

    this.window.on('unmaximize', () => {
      this.window?.webContents.send('window-maximized-change', false);
    });

    this.window.on('resize', () => {
      const window = this.getWindow();
      if (window) {
        const bounds = window.getBounds();
        const { width, height } = screen.getPrimaryDisplay().workArea;
        const isMaximized = bounds.width >= width && bounds.height >= height;
        window.webContents.send('window-maximized-change', isMaximized);
      }
    });

    this.window.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url);
      return { action: 'deny' };
    });
  }

  private loadContent(): void {
    if (!this.window) return;

    if (is.dev && process.env.ELECTRON_RENDERER_URL) {
      this.window.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      this.window.loadFile(join(__dirname, '../renderer/index.html'));
    }
  }

  setWindowMode(mode: 'window' | 'pet'): void {
    if (!this.window) return;

    this.currentMode = mode;
    this.window.setOpacity(0);

    if (mode === 'window') {
      this.setWindowModeWindow();
    } else {
      this.setWindowModePet();
    }
  }

  private setWindowModeWindow(): void {
    if (!this.window) return;

    this.stopCursorProbe();
    this.hoveringComponents.clear();

    this.window.setAlwaysOnTop(false);
    this.window.setIgnoreMouseEvents(false);
    this.window.setSkipTaskbar(false);
    this.window.setResizable(true);
    this.window.setFocusable(true);
    this.window.setAlwaysOnTop(false);

    this.window.setBackgroundColor('#ffffff');
    this.window.webContents.send('pre-mode-changed', 'window');
  }

  private continueSetWindowModeWindow(): void {
    if (!this.window) return;
    if (this.windowedBounds) {
      this.window.setBounds(this.windowedBounds);
    } else {
      this.window.setSize(900, 670);
      this.window.center();
    }

    if (isMac) {
      this.window.setWindowButtonVisibility(true);
      this.window.setVisibleOnAllWorkspaces(false, {
        visibleOnFullScreen: false,
      });
    }

    this.window?.setIgnoreMouseEvents(false, { forward: true });

    this.window.webContents.send('mode-changed', 'window');
  }

  private setWindowModePet(): void {
    if (!this.window) return;

    this.windowedBounds = this.window.getBounds();

    if (this.window.isFullScreen()) {
      this.window.setFullScreen(false);
    }

    this.window.setBackgroundColor('#00000000');

    this.window.setAlwaysOnTop(true, 'screen-saver');
    this.window.setPosition(0, 0);

    this.window.webContents.send('pre-mode-changed', 'pet');
  }

  private continueSetWindowModePet(): void {
    if (!this.window) return;
    // Calculate the bounding rectangle that covers all connected displays.
    // This allows the transparent pet-mode window to span across monitors,
    // so the avatar can be dragged freely between them.
    const displays = screen.getAllDisplays();
    const minX = Math.min(...displays.map((d) => d.bounds.x));
    const minY = Math.min(...displays.map((d) => d.bounds.y));
    const maxX = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
    const maxY = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
    const combinedWidth = maxX - minX;
    const combinedHeight = maxY - minY;

    // Resize and position the window to cover the entire virtual screen
    // so the avatar is not clipped when dragged to a second monitor.
    this.window.setBounds({
      x: minX,
      y: minY,
      width: combinedWidth,
      height: combinedHeight,
    });

    if (isMac) this.window.setWindowButtonVisibility(false);
    this.window.setResizable(false);
    this.window.setSkipTaskbar(true);
    this.window.setFocusable(false);

    if (isMac) {
      this.window.setIgnoreMouseEvents(true);
      this.window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
      });
    } else {
      this.window.setIgnoreMouseEvents(true, { forward: true });
    }

    this.startCursorProbe();

    this.window.webContents.send('mode-changed', 'pet');
  }
  
  getWindow(): BrowserWindow | null {
    return this.window;
  }

  setIgnoreMouseEvents(ignore: boolean): void {
    if (!this.window) return;

    if (isMac) {
      this.window.setIgnoreMouseEvents(ignore);
      // this.window.setIgnoreMouseEvents(ignore, { forward: true });
    } else {
      this.window.setIgnoreMouseEvents(ignore, { forward: true });
    }
  }

  maximizeWindow(): void {
    if (!this.window) return;

    if (this.isWindowMaximized()) {
      if (this.windowedBounds) {
        this.window.setBounds(this.windowedBounds);
        this.windowedBounds = null;
        this.window.webContents.send('window-maximized-change', false);
      }
    } else {
      this.windowedBounds = this.window.getBounds();
      const { width, height } = screen.getPrimaryDisplay().workArea;
      this.window.setBounds({
        x: 0, y: 0, width, height,
      });
      this.window.webContents.send('window-maximized-change', true);
    }
  }

  isWindowMaximized(): boolean {
    if (!this.window) return false;
    const bounds = this.window.getBounds();
    const { width, height } = screen.getPrimaryDisplay().workArea;
    return bounds.width >= width && bounds.height >= height;
  }

  updateComponentHover(componentId: string, isHovering: boolean): void {
    petLog('updateComponentHover', componentId, isHovering, 'mode =', this.currentMode, 'forceIgnore =', this.forceIgnoreMouse);
    if (this.currentMode === 'window') return;

    // If force ignore is enabled, don't change the mouse ignore state
    if (this.forceIgnoreMouse) return;

    if (isHovering) {
      this.hoveringComponents.add(componentId);
    } else {
      this.hoveringComponents.delete(componentId);
    }

    if (this.window) {
      const shouldIgnore = this.hoveringComponents.size === 0;
      petLog('-> setIgnoreMouseEvents', shouldIgnore, 'hovering =', [...this.hoveringComponents]);
      if (isMac) {
        this.window.setIgnoreMouseEvents(shouldIgnore);
      } else {
        this.window.setIgnoreMouseEvents(shouldIgnore, { forward: true });
      }
      if (!shouldIgnore) {
        this.window.setFocusable(true);
      }
    }
  }

  // Linux-only: feed the cursor position to the renderer so it can hit-test,
  // standing in for the mouse-move events that
  // setIgnoreMouseEvents({ forward: true }) would deliver on Windows and macOS.
  //
  // screen.getCursorScreenPoint() cannot be used here: while the pet window is
  // click-through and unfocused, Chromium receives no pointer input at all and
  // the value it returns stays frozen at wherever the cursor last was. Ask the
  // X server directly instead, via a small helper that streams XQueryPointer
  // results on stdout.
  private startCursorProbe(): void {
    if (!isLinux) return;
    this.stopCursorProbe();

    try {
      const proc = spawn('python3', ['-c', X11_POINTER_SCRIPT], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let buffer = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        // Only the newest sample matters; older ones are already stale.
        const latest = lines.filter((line) => line.length > 0).pop();
        if (!latest) return;

        const [x, y] = latest.split(' ').map(Number);
        if (Number.isFinite(x) && Number.isFinite(y)) this.dispatchCursorPoint(x, y);
      });

      proc.on('error', (error) => {
        petLog('X11 pointer helper failed to start, falling back:', error.message);
        this.pointerProc = null;
        this.startFallbackCursorProbe();
      });

      this.pointerProc = proc;
      petLog('X11 pointer helper started, pid =', proc.pid);
    } catch (error) {
      petLog('X11 pointer helper threw, falling back:', error);
      this.startFallbackCursorProbe();
    }
  }

  // Used when the X11 helper is unavailable (no python3, no X server).
  // Accurate only while the window already receives input, but better than
  // nothing.
  private startFallbackCursorProbe(): void {
    this.cursorProbeTimer = setInterval(() => {
      if (!this.window || this.window.isDestroyed()) {
        this.stopCursorProbe();
        return;
      }
      const point = screen.getCursorScreenPoint();
      this.dispatchCursorPoint(point.x, point.y);
    }, CURSOR_PROBE_INTERVAL_MS);
  }

  // Convert a screen-space cursor position into renderer viewport coordinates.
  private dispatchCursorPoint(screenX: number, screenY: number): void {
    if (!this.window || this.window.isDestroyed()) return;
    // Nothing to probe when the window is interactive anyway, or when the user
    // has explicitly forced click-through from the tray menu.
    if (this.currentMode !== 'pet' || this.forceIgnoreMouse) return;

    // X11 reports physical pixels; Electron bounds and CSS pixels are DIPs.
    const { scaleFactor } = screen.getPrimaryDisplay();
    const x = screenX / scaleFactor;
    const y = screenY / scaleFactor;

    // Content bounds, not window bounds: the window manager may place the frame
    // elsewhere than requested (GNOME pushes it below the top bar), and the
    // renderer's viewport origin follows the content area.
    const bounds = this.window.getContentBounds();
    this.window.webContents.send('pet-cursor-probe', {
      x: x - bounds.x,
      y: y - bounds.y,
    });
  }

  private stopCursorProbe(): void {
    if (this.cursorProbeTimer) {
      clearInterval(this.cursorProbeTimer);
      this.cursorProbeTimer = null;
    }
    if (this.pointerProc) {
      this.pointerProc.kill();
      this.pointerProc = null;
    }
  }

  // Toggle force ignore mouse events
  toggleForceIgnoreMouse(): void {
    this.forceIgnoreMouse = !this.forceIgnoreMouse;

    // Apply the new setting immediately
    if (this.forceIgnoreMouse) {
      if (isMac) {
        this.window?.setIgnoreMouseEvents(true);
      } else {
        this.window?.setIgnoreMouseEvents(true, { forward: true });
      }
    } else {
      // Reapply normal behavior based on hovering components
      const shouldIgnore = this.hoveringComponents.size === 0;
      if (isMac) {
        this.window?.setIgnoreMouseEvents(shouldIgnore);
      } else {
        this.window?.setIgnoreMouseEvents(shouldIgnore, { forward: true });
      }
    }

    // Notify renderer about the change
    this.window?.webContents.send('force-ignore-mouse-changed', this.forceIgnoreMouse);
  }

  // Get current force ignore state
  isForceIgnoreMouse(): boolean {
    return this.forceIgnoreMouse;
  }

  // Get current mode
  getCurrentMode(): 'window' | 'pet' {
    return this.currentMode;
  }
}
