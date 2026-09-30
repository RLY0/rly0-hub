import type { IconNode } from "lucide";
import createElement from "lucide/dist/esm/createElement.mjs";
import Boxes from "lucide/dist/esm/icons/boxes.mjs";
import Check from "lucide/dist/esm/icons/circle-check.mjs";
import ChevronDown from "lucide/dist/esm/icons/chevron-down.mjs";
import ChevronLeft from "lucide/dist/esm/icons/chevron-left.mjs";
import ChevronRight from "lucide/dist/esm/icons/chevron-right.mjs";
import ChevronUp from "lucide/dist/esm/icons/chevron-up.mjs";
import CircleArrowUp from "lucide/dist/esm/icons/circle-arrow-up.mjs";
import CircleOff from "lucide/dist/esm/icons/circle-off.mjs";
import Coffee from "lucide/dist/esm/icons/coffee.mjs";
import Copy from "lucide/dist/esm/icons/copy.mjs";
import Download from "lucide/dist/esm/icons/download.mjs";
import ExternalLink from "lucide/dist/esm/icons/external-link.mjs";
import Ellipsis from "lucide/dist/esm/icons/ellipsis.mjs";
import FolderInput from "lucide/dist/esm/icons/folder-input.mjs";
import GraduationCap from "lucide/dist/esm/icons/graduation-cap.mjs";
import GripVertical from "lucide/dist/esm/icons/grip-vertical.mjs";
import Info from "lucide/dist/esm/icons/info.mjs";
import Languages from "lucide/dist/esm/icons/languages.mjs";
import LayoutDashboard from "lucide/dist/esm/icons/layout-dashboard.mjs";
import MessagesSquare from "lucide/dist/esm/icons/messages-square.mjs";
import Network from "lucide/dist/esm/icons/network.mjs";
import PlugZap from "lucide/dist/esm/icons/plug-zap.mjs";
import RefreshCw from "lucide/dist/esm/icons/refresh-cw.mjs";
import RotateCcw from "lucide/dist/esm/icons/rotate-ccw.mjs";
import Route from "lucide/dist/esm/icons/route.mjs";
import Settings from "lucide/dist/esm/icons/settings.mjs";
import Stethoscope from "lucide/dist/esm/icons/stethoscope.mjs";
import Star from "lucide/dist/esm/icons/star.mjs";
import TriangleAlert from "lucide/dist/esm/icons/triangle-alert.mjs";
import Ticket from "lucide/dist/esm/icons/ticket.mjs";
import Trash from "lucide/dist/esm/icons/trash-2.mjs";
import Terminal from "lucide/dist/esm/icons/terminal.mjs";
import Search from "lucide/dist/esm/icons/search.mjs";
import Server from "lucide/dist/esm/icons/server.mjs";
import CircleHelp from "lucide/dist/esm/icons/circle-question-mark.mjs";
import X from "lucide/dist/esm/icons/x.mjs";
import Users from "lucide/dist/esm/icons/users.mjs";
import Waypoints from "lucide/dist/esm/icons/waypoints.mjs";
import Plus from "lucide/dist/esm/icons/plus.mjs";
import codexhostLogoUrl from "../assets/codexhost-app-icon.svg";

export const RENDERER_SETTINGS_ICON_NAMES = [
  "settings",
  "close",
  "star",
  "github",
  "language",
  "dashboard",
  "connections",
  "accounts",
  "session-import",
  "threads",
  "mcp",
  "relay",
  "skills",
  "add",
  "model-pool",
  "routes",
  "gateway",
  "updates",
  "about",
  "info",
  "external-link",
  "refresh",
  "unavailable",
  "alert",
  "check",
  "diagnose",
  "copy",
  "download",
  "chevron-left",
  "chevron-right",
  "chevron-down",
  "chevron-up",
  "grip-vertical",
  "undo",
  "ticket",
  "trash",
  "terminal",
  "search",
  "help",
  "ellipsis",
  "coffee",
] as const;

export type RendererSettingsIconName = (typeof RENDERER_SETTINGS_ICON_NAMES)[number];

const iconNodes = {
  settings: Settings,
  close: X,
  star: Star,
  github: [
    [
      "path",
      {
        fill: "currentColor",
        stroke: "none",
        d: "M12 .297C5.37.297 0 5.67 0 12.297c0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.043-1.61-4.043-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.084 1.838 1.237 1.838 1.237 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.467-1.334-5.467-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23a11.5 11.5 0 0 1 3-.405c1.02.005 2.045.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
      },
    ],
  ],
  language: Languages,
  connections: PlugZap,
  accounts: Users,
  "session-import": FolderInput,
  dashboard: LayoutDashboard,
  threads: MessagesSquare,
  mcp: Server,
  relay: Waypoints,
  skills: GraduationCap,
  add: Plus,
  "model-pool": Boxes,
  routes: Route,
  gateway: Network,
  updates: CircleArrowUp,
  about: Info,
  info: Info,
  "external-link": ExternalLink,
  refresh: RefreshCw,
  unavailable: CircleOff,
  alert: TriangleAlert,
  check: Check,
  diagnose: Stethoscope,
  copy: Copy,
  download: Download,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  "chevron-down": ChevronDown,
  "chevron-up": ChevronUp,
  "grip-vertical": GripVertical,
  undo: RotateCcw,
  ticket: Ticket,
  trash: Trash,
  terminal: Terminal,
  search: Search,
  help: CircleHelp,
  ellipsis: Ellipsis,
  coffee: Coffee,
} satisfies Record<RendererSettingsIconName, IconNode>;

export function isRendererSettingsIconName(value: string): value is RendererSettingsIconName {
  return (RENDERER_SETTINGS_ICON_NAMES as readonly string[]).includes(value);
}

export function createRendererSettingsIcon(name: RendererSettingsIconName, size = 18): SVGElement {
  const icon = createElement(iconNodes[name], {
    width: size,
    height: size,
    "aria-hidden": "true",
    focusable: "false",
  });
  icon.classList.add("codexhost-settings-icon");
  return icon;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const RLY0_MARK_PATH =
  "M140.209,185.084l-30.428-0.008l-0.014,4.978l4.053,0.027l-0.028,4.518l-10.271-0.038l0.007-9.484 l-16.996,0.004c-6.357-0.246-12.022-3.784-14.713-9.534c-3.168-6.77-1.165-14.588,4.593-19.223l-2.956-0.067 c-5.411-0.124-10.487-2.147-14.089-6.106c-7.474-8.214-5.697-20.863,3.513-26.869c-3.856-1.014-7.058-2.929-9.575-5.786 c-6.502-7.378-5.79-18.433,1.547-24.976c3.31-2.952,7.433-4.695,11.94-4.749l10.335-0.122c-7.811-4.262-11.087-13.515-7-21.504 c2.703-5.285,8.238-8.987,14.383-8.988l80.908-0.001c6.793,0,12.823,4.433,15.167,10.611c2.943,7.757-0.546,16.026-7.763,19.897 l10.056,0.092c5.292,0.049,10.198,2.277,13.716,6.208c4.243,4.741,5.657,11.227,3.658,17.3 c-1.992,6.051-6.925,10.425-13.151,12.013c4.824,3.135,7.898,8.411,8.162,14.081c0.275,5.911-2.371,11.488-7.146,15.086 c-3.245,2.46-7.03,3.698-11.122,3.805l-3.394,0.089c7.849,6.304,8.138,17.935,0.511,24.586c-3.122,2.722-7.028,4.154-11.271,4.154 l-16.344-0.001l-0.023,4.96l4.065,0.058l-0.048,4.477l-10.247,0L140.209,185.084z M119.493,114.179l0.008-5.621 c0.004-2.644-2.403-4.483-4.83-4.577c-2.486-0.097-5.194,1.578-5.2,4.255l-0.014,6.158c-0.006,2.704,2.703,4.457,5.218,4.365 C117.059,118.671,119.489,116.905,119.493,114.179z M140.566,114.217l-0.016-5.88c-0.007-2.636-2.606-4.378-5.053-4.363 c-2.372,0.015-4.939,1.679-4.945,4.263l-0.015,6.161c-0.006,2.691,2.685,4.454,5.212,4.358 C138.093,118.665,140.574,116.943,140.566,114.217z";

/**
 * RLY/0 mark for native icon surfaces such as the rail: the figure follows
 * `currentColor` (eyes are cut out with even-odd fill) and keeps the RLY/0
 * signal-orange square so the entry is recognizable at 20px.
 */
export function createRendererSettingsBrandGlyph(size = 20): SVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "56 44 158 158");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const figure = document.createElementNS(SVG_NAMESPACE, "path");
  figure.setAttribute("d", RLY0_MARK_PATH);
  figure.setAttribute("fill", "currentColor");
  figure.setAttribute("fill-rule", "evenodd");
  const signal = document.createElementNS(SVG_NAMESPACE, "rect");
  signal.setAttribute("x", "190");
  signal.setAttribute("y", "50");
  signal.setAttribute("width", "18");
  signal.setAttribute("height", "18");
  signal.setAttribute("fill", "#ff4b2e");
  svg.append(figure, signal);
  svg.classList.add("codexhost-settings-icon");
  return svg;
}

export function createRendererSettingsBrandIcon(size = 22): HTMLImageElement {
  const icon = document.createElement("img");
  icon.src = codexhostLogoUrl;
  icon.alt = "";
  icon.width = size;
  icon.height = size;
  icon.draggable = false;
  icon.setAttribute("aria-hidden", "true");
  icon.style.width = `${size}px`;
  icon.style.height = `${size}px`;
  icon.style.objectFit = "contain";
  icon.classList.add("codexhost-settings-icon");
  return icon;
}
