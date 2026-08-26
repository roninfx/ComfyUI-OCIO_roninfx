// ComfyUI-OCIO - preset behavior for "CoSA OCIODisplay 2.0" (CoSAOCIODisplayColorSpace).
// The `preset` combo (Manual/EXR/PNG/MP4, first widget) writes ONLY the four source-dependent widgets:
// in_colorspace, display, view, invert_direction. NOTHING else is ever touched - out_colorspace, mix,
// config_path, preview all keep whatever the user set (that is the whole point vs the removed v1 presets).
// Manual writes nothing. Hand-editing any of the four flips the preset back to Manual so the label never
// lies about what is driving the values.
// Values below are the ones validated pixel-for-pixel against the CoSA_OCIO v16 "Original" chains
// (EXR = forward Raw passthrough; PNG = inverse of the sRGB-encoded ODT; MP4 = inverse of the Rec.1886 ODT).
import { app } from "../../scripts/app.js";

const PRESETS = {
    EXR: { in_colorspace: "ACEScg",
           display: "Rec.1886 Rec.709 - Display",
           view: "Raw",
           invert_direction: false },
    PNG: { in_colorspace: "sRGB Encoded Rec.709 (sRGB)",
           display: "sRGB - Display",
           view: "ACES 1.0 - SDR Video",
           invert_direction: true },
    MP4: { in_colorspace: "sRGB Encoded Rec.709 (sRGB)",
           display: "Rec.1886 Rec.709 - Display",
           view: "ACES 1.0 - SDR Video",
           invert_direction: true },
};
const DRIVEN = ["in_colorspace", "display", "view", "invert_direction"];

// OUTPUT recipes (CoSA OCIO Output Transform): the pipeline run FORWARD out of ACEScct. EXR keeps the data
// scene-referred (Raw view + ACEScct->ACEScg re-encode); PNG/MP4 bake the forward ODT. Unlike the input node,
// out_colorspace IS preset-driven here - the EXR delivery IS that re-encode, and PNG/MP4 must clear it.
const OUT_PRESETS = {
    EXR: { in_colorspace: "ACEScct", display: "Rec.1886 Rec.709 - Display", view: "Raw",
           invert_direction: false, out_colorspace: "ACEScg" },
    PNG: { in_colorspace: "ACEScct", display: "sRGB - Display", view: "ACES 1.0 - SDR Video",
           invert_direction: false, out_colorspace: "(none - raw)" },
    MP4: { in_colorspace: "ACEScct", display: "Rec.1886 Rec.709 - Display", view: "ACES 1.0 - SDR Video",
           invert_direction: false, out_colorspace: "(none - raw)" },
};
const isOutputTransform = (n) => (n && (n.comfyClass === "CoSAOCIOOutputTransform" || n.type === "CoSAOCIOOutputTransform"));
const tableOf = (n) => (isOutputTransform(n) ? OUT_PRESETS : PRESETS);
const drivenOf = (n) => (isOutputTransform(n) ? [...DRIVEN, "out_colorspace"] : DRIVEN);
// Downstream CoSA Write's chosen format -> preset name (video container = MP4; stills by still_format).
function writePresetOf(writeNode) {
    const c = W(writeNode, "container")?.value;
    if (c === "video") return "MP4";
    const f = String(W(writeNode, "still_format")?.value || "").toLowerCase();
    if (f === "exr") return "EXR";
    if (["png", "jpg", "jpeg", "tif", "tiff"].includes(f)) return "PNG";
    return null;
}
function senseFromWrite(otNode, writeNode, { overrideManual }) {
    const preset = W(otNode, "preset");
    if (!preset) return;
    if (preset.value === "Manual" && !overrideManual) return;
    const wanted = writePresetOf(writeNode);
    if (!wanted || preset.value === wanted) return;
    preset.value = wanted;
    applyPreset(otNode, wanted);
}
// A Write's format changed: re-sense every Output Transform wired into it (tracking presets only - Manual
// stays parked, same contract as the Read-side file swap).
window.addEventListener("cosa:write-format-changed", (ev) => {
    try {
        const g = app.graph;
        const wr = g && g.getNodeById(ev.detail && ev.detail.nodeId);
        if (!wr) return;
        for (const inp of wr.inputs || []) {
            if (inp.link == null) continue;
            const link = g.links[inp.link];
            const origin = link && g.getNodeById(link.origin_id);
            if (origin && isOutputTransform(origin)) senseFromWrite(origin, wr, { overrideManual: false });
        }
    } catch (e) { /* re-sensing must never break the app */ }
});

// File extension -> preset, shared by connect-time sensing and file-swap re-sensing.
function extPreset(ext) {
    if (["exr", "hdr"].includes(ext)) return "EXR";
    if (["png", "jpg", "jpeg", "tif", "tiff"].includes(ext)) return "PNG";
    if (["mp4", "mov", "mkv", "avi", "webm", "m4v", "mxf"].includes(ext)) return "MP4";
    return null;
}
function senseFromRead(stNode, readNode, { overrideManual }) {
    const preset = W(stNode, "preset");
    if (!preset) return;
    if (preset.value === "Manual" && !overrideManual) return;   // parked on Manual = hands off (file swaps only)
    const srcVal = String(W(readNode, "source")?.value || "");
    const wanted = extPreset(srcVal.toLowerCase().split(".").pop() || "");
    if (!wanted || preset.value === wanted) return;
    preset.value = wanted;
    applyPreset(stNode, wanted);
}
// FILE-SWAP RE-SENSING (2026-08-26): a Read announces source changes; every Source Transform connected to
// its outputs re-senses - but ONLY while the preset is tracking (EXR/PNG/MP4). A preset parked on Manual
// stays parked; a fresh CONNECTION is the only thing that overrides Manual (user-specified contract).
window.addEventListener("cosa:read-source-changed", (ev) => {
    try {
        const g = app.graph;
        const read = g && g.getNodeById(ev.detail && ev.detail.nodeId);
        if (!read) return;
        for (const out of read.outputs || []) {
            for (const linkId of out.links || []) {
                const link = g.links[linkId];
                const target = link && g.getNodeById(link.target_id);
                if (target && (target.comfyClass === "CoSAOCIOSourceTransform" || target.type === "CoSAOCIOSourceTransform")) {
                    senseFromRead(target, read, { overrideManual: false });
                }
            }
        }
    } catch (e) { /* re-sensing must never break the app */ }
});

const W = (node, name) => (node.widgets || []).find((w) => w.name === name);

function applyPreset(node, name) {
    const vals = tableOf(node)[name];
    if (!vals) return;                          // Manual (or unknown): hands off
    node.__cosaApplying = true;                 // guard: our own writes must not bounce preset back to Manual
    try {
        for (const key of Object.keys(vals)) {
            const w = W(node, key);
            if (!w) continue;
            if (w.value === vals[key]) continue;
            w.value = vals[key];
            if (w.callback) w.callback(w.value, app.canvas, node);
        }
    } finally {
        node.__cosaApplying = false;
    }
    node.setDirtyCanvas?.(true, true);
}


// Whole-process title-bar label, same style/position as OCIO Read's (see ocio_io.js): the full chain this
// node applies, not just one pair. Forward: in -> display(view) -> out. Inverse: display(view)^-1 -> in ->
// out. View "Raw" is a no-op display stage, so the label collapses to the only real math: in -> out (or
// "raw passthrough" when there is no out re-encode either). Values re-read every frame, so preset flips
// and hand edits update it live.
function shortenCs(cs) {
    return String(cs || "")
        .replace(" - Display", "")
        .replace("ACES 1.0 - SDR Video", "SDR Video")
        .replace("ACES 2.0 - SDR 100 nits", "SDR 100nits")
        .replace("sRGB Encoded Rec.709 (sRGB)", "sRGB Enc.709");
}
function installChainLabel(node) {
    if (node.__cosaChainLabel) return;
    node.__cosaChainLabel = true;
    const orig = node.onDrawForeground;
    node.onDrawForeground = function (ctx) {
        const r = orig ? orig.apply(this, arguments) : undefined;
        if (this.flags && this.flags.collapsed) return r;
        const val = (n) => { const w = W(this, n); return w ? w.value : undefined; };
        const inCs = shortenCs(val("in_colorspace")), disp = shortenCs(val("display"));
        const view = val("view"), inv = !!val("invert_direction");
        const out = val("out_colorspace");
        const hasOut = out && out !== "(none - raw)";
        let parts;
        if (view === "Raw") {
            parts = hasOut ? [inCs, shortenCs(out)] : [inCs + " (raw passthrough)"];
        } else {
            const stage = `${disp} (${shortenCs(view)})` + (inv ? "⁻¹" : "");
            parts = inv ? [stage, inCs] : [inCs, stage];
            if (hasOut) parts.push(shortenCs(out));
        }
        ctx.save();
        ctx.font = "12px sans-serif"; ctx.fillStyle = "#9cf"; ctx.textAlign = "right";
        // Above the CoSA banner (banner spans y -60..-30, title bar -30..0): stacked label / banner / title,
        // nothing overlapping. Bottom-of-node placement was tried on paper and rejected as too far from the eye.
        // Preset name leads the label (user request 2026-08-26), same "what next to how" pattern as the Read
        // node's file-type prefix - Manual is worth naming too, since it is the one state where the four
        // driven fields could say ANYTHING and the label alone would not explain why.
        const presetVal = val("preset");
        const tag = presetVal ? `${presetVal}: ` : "";
        ctx.fillText(tag + parts.join(" → "), this.size[0] - 8, -66);
        ctx.restore();
        return r;
    };
}

app.registerExtension({
    name: "ComfyUI-OCIO.display2preset",
    async nodeCreated(node) {
        const _cls = node?.comfyClass || node?.type;
        if (_cls !== "CoSAOCIOSourceTransform" && _cls !== "CoSAOCIOOutputTransform") return;
        const preset = W(node, "preset");
        if (!preset || preset.__cosaPresetWired) return;
        preset.__cosaPresetWired = true;
        installChainLabel(node);

        // Preset picked -> write the four driven widgets. Wrap, don't replace: keep combo default behavior.
        const prevCb = preset.callback;
        preset.callback = function (value, ...rest) {
            const r = prevCb ? prevCb.call(this, value, ...rest) : undefined;
            applyPreset(node, value);
            return r;
        };

        // CONNECT-TIME SENSING (2026-08-26, user-specified contract): the moment an image/video input is
        // CONNECTED, sense the upstream CoSA Read's file type ONCE and switch the preset to match - even
        // from Manual (Manual is the shipped default, so a fresh node must self-configure on first wiring).
        // Never re-evaluated afterward: file swaps on the connected Read do NOT re-trigger (deliberate), and
        // the user can flip back to Manual and it sticks until the next reconnection. Skipped during
        // workflow load (app.configuringGraph), where LiteGraph replays connections and sensing would stomp
        // every saved preset choice.
        const prevConn = node.onConnectionsChange;
        node.onConnectionsChange = function (type, slotIndex, connected, linkInfo, ioSlot) {
            const r = prevConn ? prevConn.apply(this, arguments) : undefined;
            try {
                if (app.configuringGraph) return r;
                if (!connected) return r;
                if (type === 1 && !isOutputTransform(node)) {                // INPUT side: Read -> Input Transform
                    const name = ioSlot && ioSlot.name;
                    if (name !== "image" && name !== "video") return r;
                    const link = linkInfo || (this.graph && this.graph.links && this.graph.links[ioSlot.link]);
                    const origin = link && this.graph && this.graph.getNodeById(link.origin_id);
                    if (!origin || origin.type !== "OCIORead") return r;
                    senseFromRead(node, origin, { overrideManual: true });   // fresh wiring overrides even Manual
                } else if (type === 2 && isOutputTransform(node)) {          // OUTPUT side: Output Transform -> Write
                    const target = linkInfo && this.graph && this.graph.getNodeById(linkInfo.target_id);
                    if (!target || (target.comfyClass !== "OCIOWrite" && target.type !== "OCIOWrite")) return r;
                    senseFromWrite(node, target, { overrideManual: true });  // fresh wiring overrides even Manual
                }
            } catch (e) { /* sensing must never break wiring */ }
            return r;
        };

        // Hand-editing a driven widget -> flip preset back to Manual (only when WE are not the writer).
        // Deliberately NOT applied on workflow load (loads restore saved values without callbacks firing).
        for (const key of drivenOf(node)) {
            const w = W(node, key);
            if (!w || w.__cosaManualWired) continue;
            w.__cosaManualWired = true;
            const cb = w.callback;
            w.callback = function (value, ...rest) {
                const r = cb ? cb.call(this, value, ...rest) : undefined;
                if (!node.__cosaApplying && preset.value !== "Manual") {
                    preset.value = "Manual";
                    node.setDirtyCanvas?.(true, true);
                }
                return r;
            };
        }
    },
});
