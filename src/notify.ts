import { Notice, setIcon } from "obsidian";
import {
	KIND_ICON,
	noticeDuration,
	noticeRole,
	type NotifyAction,
	type NotifyOptions,
} from "./core/notify-model";

/**
 * Build a standard notice: a Lucide icon accent, a word-first title, an optional
 * muted detail line, and an optional one-tap action link.
 *
 * The accent lives on the ICON, never as a full-bleed background. A saturated
 * block behind body text is the contrast problem this replaces.
 */
function buildFragment(opts: NotifyOptions, hide: () => void): DocumentFragment {
	const iconName = opts.icon ?? KIND_ICON[opts.kind];
	return createFragment((f) => {
		const root = f.createDiv({ cls: ["cp-notice", `cp-notice--${opts.kind}`] });
		const role = noticeRole(opts);
		if (role) root.setAttribute("role", role);
		const head = root.createDiv({ cls: "cp-notice-head" });
		setIcon(head.createSpan({ cls: "cp-notice-icon" }), iconName);
		head.createSpan({ cls: "cp-notice-title", text: opts.title });
		if (opts.detail !== undefined) {
			root.createDiv({ cls: "cp-notice-detail", text: opts.detail });
		}
		const action = opts.action;
		if (action !== undefined) {
			const link = root.createEl("a", {
				cls: "cp-notice-action",
				text: action.label,
				href: "#",
			});
			link.addEventListener("click", (event) => {
				event.preventDefault();
				// A tap anywhere on a Notice dismisses it; keep the link independent.
				event.stopPropagation();
				action.run();
				if (action.hideOnRun !== false) hide();
			});
		}
	});
}

export function notify(opts: NotifyOptions): Notice {
	let notice: Notice;
	const fragment = buildFragment(opts, () => {
		notice.hide();
	});
	notice = new Notice(fragment, noticeDuration(opts));
	return notice;
}

const make =
	(kind: NotifyOptions["kind"]) =>
	(title: string, detail?: string, action?: NotifyAction): Notice =>
		notify({
			kind,
			title,
			...(detail !== undefined && { detail }),
			...(action !== undefined && { action }),
		});

export const notifySuccess = make("success");
export const notifyInfo = make("info");
export const notifyWarning = make("warning");
export const notifyError = make("error");
