import {ChevronFirst, ChevronLast, Keyboard, Paperclip, type LucideIcon} from "lucide-react";
import type {ToolbarKey} from "./preferences";

/** Keys drawn as an icon, in the terminal and in the toolbar editor's preview; the key's accessible name carries the meaning. */
export const toolbarIcons: Partial<Record<ToolbarKey, LucideIcon>> = {attach: Paperclip, keyboard: Keyboard, Home: ChevronFirst, End: ChevronLast};
