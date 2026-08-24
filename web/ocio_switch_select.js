// ComfyUI-OCIO - grey out the "manual" widgets on a CoSA_OCIO-style switch box when a non-Manual preset is
// picked, so it is obvious at a glance which widgets currently drive the output. Generic on purpose: it does
// not target a specific registered node type (a subgraph's collapsed boundary node has a dynamic UUID type,
// not a stable name beforeRegisterNodeDef could match), it just looks for a widget literally named "preset"
// whose options are exactly ["Manual", "EXR", "PNG", "MP4"] - the OCIOSwitchSelect combo, wherever it ends up
// after subgraph widget promotion - and dims the manual OCIOColorSpace widgets riding alongside it.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const BANNER_H = 30;
// Drawn ABOVE the node (negative Y, outside its bounds, clipped to the title-bar area) rather than pushed
// into the input/output slot row below the title - that row is drawn by this subgraph boundary node's own
// custom renderer, which ignores every native repositioning hook tried (widgets_start_y, per-slot `.pos`),
// so it cannot be displaced. -60 is the confirmed-good vertical position - do NOT change this value again
// without the user explicitly confirming a new one first (a -90 experiment made the position worse without
// fixing an unrelated overlap, since the overlap turned out not to be a banner-vs-title distance problem).
const BANNER_Y = -60;
// Resolved relative to THIS file's own URL rather than a guessed mount path (e.g. "/extensions/<pack>/...")
// - ComfyUI's exact static-asset URL scheme for a custom node's web/ directory is not something to assume,
// but wherever this script itself was actually served from, a sibling file in the same directory is
// guaranteed to resolve correctly from there. Loaded once at module scope and shared by every box instance.
const BANNER_IMG = new Image();
BANNER_IMG.src = new URL("cosa_banner.png", import.meta.url).href;

const MANUAL_WIDGET_NAMES = new Set([
    "mix", "config_path", "view_display", "view_transform", "preview",
]);
// Deliberately NOT greyed like the rest of MANUAL_WIDGET_NAMES: all three preset chains' final node
// currently share the exact same in/out colorspace (ACEScg -> ACEScct), so instead of locking these two
// down, changing them here broadcasts the new value onto that shared setting on all three chains too - a
// fast way to test a different final colorspace across every preset without entering the subgraph and
// editing three nodes by hand. See propagateSharedColorspace / findPresetChainFinalNodes below.
const SHARED_COLORSPACE_WIDGETS = ["in_colorspace", "out_colorspace"];
const PRESET_VALUES = ["Manual", "EXR", "PNG", "MP4"];
// Sampled from cosa_banner.png's own lettering - ties the preset combo's color back to the logo above it.
const PRESET_TINT = "#5b78b3";

function widget(node, name) {
    return (node.widgets || []).find((w) => w.name === name);
}
// Tint the "preset" combo blue (matching the banner) via a per-widget `.draw` override - LiteGraph calls a
// widget's own `draw(ctx, node, widget_width, y, height)` instead of the shared combo renderer when present,
// so this replaces its look without touching hit-testing/click handling (those read the widget's bounding
// box, computed elsewhere, not this function) - unlike the slot `.pos` trick, this is a documented per-widget
// hook, not a property a specific renderer may or may not consult.
function installPresetTint(node) {
    const w = widget(node, "preset");
    if (!w || w.__ocioTinted) return;
    w.__ocioTinted = true;
    w.draw = function (ctx, n, widget_width, y, H) {
        const margin = 15;
        const x = margin, width = widget_width - margin * 2, height = H || 20;
        ctx.save();
        ctx.strokeStyle = this.disabled ? "#3a466f" : "#7f97cf";
        ctx.fillStyle = this.disabled ? "#31395c" : PRESET_TINT;
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, width, height, height * 0.5);
        else ctx.rect(x, y, width, height);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = this.disabled ? "#8892b0" : "#fff";
        ctx.font = "12px Arial";
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.fillText("◀", x + 8, y + height * 0.5);
        ctx.fillText(this.name || this.label || "", x + 20, y + height * 0.5);
        ctx.textAlign = "right";
        ctx.fillText("▶", x + width - 8, y + height * 0.5);
        ctx.fillText(String(this.value), x + width - 20, y + height * 0.5);
        ctx.restore();
    };
}
function applyGray(node, preset, redraw) {
    const manual = preset === "Manual";
    for (const w of node.widgets || []) {
        if (!MANUAL_WIDGET_NAMES.has(w.name)) continue;
        w.disabled = !manual;
    }
    if (redraw !== false && node.setDirtyCanvas) node.setDirtyCanvas(true, true);
}

// A subgraph's collapsed boundary node only ever gets the widgets its interior nodes had promoted onto it -
// promotion carries VALUE widgets (combo/int/float/etc, wired through a link) but not the plain button
// widgets ocio_io.js / ocio_swap.js / ocio_upload.js add to real OCIOColorSpace nodes via onNodeCreated,
// since a button has no serializable value for a link to carry. Those three extensions match by registered
// node NAME, and a subgraph's collapsed node has a dynamic UUID type instead of a stable name, so they never
// fire on it. Rebuilt here instead, gated on the SAME "preset" signature as the greying above so it only
// ever touches an actual CoSA_OCIO-style switch box, not an unrelated node that happens to share widget names.
function addMissingChrome(node) {
    if (!widget(node, "upload .ocio config") && widget(node, "config_path")) {
        node.addWidget("button", "upload .ocio config", null, () => {
            const inp = document.createElement("input");
            inp.type = "file";
            inp.accept = ".ocio";
            inp.style.display = "none";
            document.body.appendChild(inp);
            inp.onchange = async () => {
                if (!inp.files || !inp.files.length) { inp.remove(); return; }
                const fd = new FormData();
                fd.append("file", inp.files[0]);
                try {
                    const resp = await fetch("/ocio/upload", { method: "POST", body: fd });
                    const data = await resp.json();
                    if (data && data.path) {
                        const w = widget(node, "config_path");
                        if (w) {
                            if (w.options && Array.isArray(w.options.values) && !w.options.values.includes(data.path)) {
                                w.options.values.push(data.path);
                            }
                            w.value = data.path;
                            if (w.callback) w.callback(w.value);
                            node.setDirtyCanvas(true, true);
                        }
                    } else {
                        console.error("OCIO upload: unexpected response", data);
                    }
                } catch (e) {
                    console.error("OCIO upload failed", e);
                }
                inp.remove();
            };
            inp.click();
        }, { serialize: false });
    }
    if (!widget(node, "⇄ swap in/out") && widget(node, "in_colorspace") && widget(node, "out_colorspace")) {
        node.addWidget("button", "⇄ swap in/out", null, () => {
            const a = widget(node, "in_colorspace");
            const b = widget(node, "out_colorspace");
            if (a && b) {
                const t = a.value;
                a.value = b.value;
                b.value = t;
                if (a.callback) a.callback(a.value);
                if (b.callback) b.callback(b.value);
            }
            node.setDirtyCanvas(true, true);
        }, { serialize: false });
    }
    if (!widget(node, "▾ Viewer")) {
        const toggle = node.addWidget("button", "▾ Viewer", null, () => {
            const hidden = node.__ocioThumbHidden = !node.__ocioThumbHidden;
            toggle.name = (hidden ? "▸" : "▾") + " Viewer";
            node.setSize([node.size[0], node.computeSize()[1]]);
            node.setDirtyCanvas(true, true);
        }, { serialize: false });
    }
    // Back to a plain widget button after two failed attempts at a custom-drawn one below the thumbnail -
    // this is the same addWidget("button", ...) mechanism upload/swap/viewer all use reliably, unlike the
    // custom onMouseDown path, which turned out to have a deeper click-dispatch problem on this node type
    // that a hit-box fix alone did not solve. Trades the exact "below the picture" position for something
    // that actually responds to clicks.
    if (!widget(node, "▶ Run")) {
        const runW = node.addWidget("button", "▶ Run", null, () => {
            runToNode(node.id, runW);
        }, { serialize: false });
    }
    // Widgets added here land in node.widgets, but a node LOADED from a saved workflow keeps its saved
    // box height - which predates these buttons existing at all - so without this they are added to the
    // data model but drawn below the visible bottom edge of the node, effectively invisible. Only the
    // "▾ Viewer" toggle self-corrected its own size (on click, after folding/unfolding); the others
    // never did, so on a fresh load the box was too short for all four.
    node.setSize([node.size[0], node.computeSize()[1]]);
    node.setDirtyCanvas(true, true);
}

// Queue a run scoped to JUST this box's own Thumbnail node, using ComfyUI's OWN native partial-execution
// support instead of hand-simulating one. Confirmed real by reading server.py directly: POST /prompt accepts
// a top-level `partial_execution_targets` (a list of node ids) which execution.py's validate_prompt/execute
// use to resolve and run only that target's real dependency chain - the exact mechanism behind the native
// per-node "Run" command (right-click a node -> Run), which the user confirmed always produces the CORRECT
// result.
//
// Every previous version of this function hand-simulated "run only what's needed" by muting (node.mode =
// NEVER) everything judged unnecessary, then calling the ordinary queuePrompt(). That approach failed FIVE
// separate ways as the box's nested-subgraph structure kept exposing new edge cases: a boundary node muting
// itself, an indirect PrimitiveInt relay the resolver didn't know to walk through, a second subgraph-nesting
// layer inside "OCIO Switch In", a shared passthrough node (118) muted by whichever unselected chain reached
// it first, and finally - the one that actually got caught by the user, not by testing here - the muting
// itself could make ComfyUI's OWN caching think a node's inputs matched an EARLIER (different-preset) run,
// serving a stale cached result instead of recomputing. That last one is why clicking this button could show
// a DIFFERENT image than genuinely re-running the same node natively: no error, just silently wrong output.
// A mute-based simulation can never fully rule out that class of bug, because it changes what ComfyUI
// considers the graph's true state; calling the real backend feature does not have this problem, because
// nothing about the graph's actual node modes is touched at all - only which targets get resolved.
// Which prompt_ids were queued from an OCIO "▶ Run" button, and the button widget to reflect their progress
// on. Updated from the "executing" WebSocket event (below) when that arrives, and from pollHistory (below)
// regardless of whether it does - the WS event alone was not reliably resetting this button even once
// queued through ComfyUI's own api.queuePrompt(), so polling is the primary mechanism now, not a fallback.
const RUNNING_RUN_BUTTONS = new Map();
// Poll /history for promptId every second for up to 2 minutes, resetting runWidget back to "▶ Run" as soon
// as it shows up done. mySeq gates every step so a click superseded by a later one (see runToNode) simply
// stops polling instead of fighting over the button.
function pollHistory(promptId, runWidget, mySeq, attempt = 0) {
    if (runWidget.__ocioClickSeq !== mySeq) return; // superseded - abandon this poll chain
    fetch(api.apiURL(`/history/${promptId}`)).then((r) => r.json()).then((hist) => {
        if (runWidget.__ocioClickSeq !== mySeq) return;
        if (hist && hist[promptId]) {
            runWidget.name = "▶ Run";
            RUNNING_RUN_BUTTONS.delete(promptId);
            app.graph.setDirtyCanvas(true, true);
            refreshFromHistory(promptId);
            return;
        }
        if (attempt >= 120) return; // ~2 minutes of 1s polling - give up, leave it to whatever else fires
        setTimeout(() => pollHistory(promptId, runWidget, mySeq, attempt + 1), 1000);
    }).catch(() => {
        if (attempt >= 120) return;
        setTimeout(() => pollHistory(promptId, runWidget, mySeq, attempt + 1), 1000);
    });
}
function findSourceReadNodeForPreset(preset, fullPrompt) {
    const nodeIdMap = { "EXR": "99", "PNG": "56", "MP4": "27" };
    const nodeId = nodeIdMap[preset];
    return nodeId && fullPrompt[nodeId] ? nodeId : null;
}

async function runToNode(boundaryId, runWidget) {
    // A monotonic click sequence number, not just "did a newer click start" - three rapid clicks can have
    // their queuePrompt() responses arrive back OUT OF ORDER (network/server timing, nothing to do with
    // click order). Invalidating __ocioCurrentPromptId only at the START of the NEXT click does not stop an
    // OLDER click's response, arriving LATE, from unconditionally overwriting a NEWER click's already-valid
    // registration once it finally resolves. mySeq is captured synchronously, before any await, so every
    // continuation below can check "am I still the most recent click" regardless of arrival order - a click
    // can only act on the button if its own sequence number still matches the widget's latest.
    const mySeq = runWidget ? (runWidget.__ocioClickSeq = (runWidget.__ocioClickSeq || 0) + 1) : null;
    if (runWidget) { runWidget.name = "⏳ Queuing..."; app.graph.setDirtyCanvas(true, true); }
    try {
        const exported = await app.graphToPrompt();
        const full = exported.output || {};
        const prefix = `${boundaryId}:`;
        const targetId = Object.keys(full).find((k) => k.startsWith(prefix) && full[k].class_type === "PreviewImage");
        if (!targetId) { console.warn("[OCIO] runToNode: no PreviewImage found under", boundaryId); return; }
        // Find the boundary node itself (for the batch_index widget below).
        const boundaryNode = app.graph._nodes.find((n) => n.id == boundaryId);
        // The preset that decides WHICH PHYSICAL FILE gets read is the ROOT-level "Source Switch Select"
        // node's own preset - NOT the boundary's own "preset" widget. Both happen to be promoted from an
        // OCIOSwitchSelect node and share the widget name "preset", but they are two INDEPENDENT axes: the
        // root one picks EXR/PNG/MP4 (which OCIORead feeds data into the box), the boundary's own one picks
        // Manual-vs-recipe PROCESSING once data is already inside. Reading the boundary's own value here
        // (as this used to) silently broke narrowing/re-read forcing whenever that inner selector was left
        // on "Manual" - findSourceReadNodeForPreset("Manual", ...) matches nothing, so both fixes below
        // quietly no-op and the box shows whatever was last cached, regardless of any frame/preset change.
        const rootSwitchNode = app.graph._nodes.find((n) => n.title === "Source Switch Select" && n.id != boundaryId);
        const presetWidget = rootSwitchNode ? widget(rootSwitchNode, "preset") : null;
        const preset = presetWidget ? String(presetWidget.value) : "";
        // Force the EXPORTED prompt's own preset input to match this live value, in case the user clicked
        // the preset combo and Run back-to-back: graphToPrompt() reads whatever LiteGraph most recently
        // serialized, and switching a combo then immediately clicking a button one frame later has been
        // observed to submit the PREVIOUS preset (needing a second, otherwise-identical click to "catch up").
        // Overwriting it here from the widget's own live .value removes any dependency on serialization
        // timing - this can only ever match or correct what graphToPrompt() produced, never regress it.
        if (rootSwitchNode && presetWidget && full[rootSwitchNode.id] && full[rootSwitchNode.id].inputs) {
            full[rootSwitchNode.id].inputs.preset = preset;
        }
        // Find the source read node (OCIORead) for the active preset. Include ALL THREE read nodes in
        // execution targets, not just the active one: the ThreeWaySwitch nodes that route data into this
        // box (141/142) wire all three OCIORead outputs as real graph inputs, so ComfyUI's dependency
        // resolver executes all three every run regardless of which one the switch actually selects - the
        // switch only picks AFTER all three have already computed. Leaving the inactive two out of the
        // target list let them run (or serve a stale cache) with whatever settings they last had, which
        // measurably produced the wrong displayed frame after toggling presets back and forth.
        const sourceReadId = findSourceReadNodeForPreset(preset, full);
        const ALL_READ_IDS = ["99", "56", "27"];
        const readTargets = ALL_READ_IDS.filter((id) => full[id]);
        const targets = [...readTargets, boundaryId, targetId];
        // NARROW every read to just the one requested frame. OCIORead's "sequence"/"video" modes decode the
        // WHOLE start_frame..end_frame span into a batch on every execution - the downstream "First frame
        // only" (ImageFromBatch) node only THINS the result afterward, it does not stop the extra frames
        // from being read. A 44-frame PNG sequence was measured taking ~25s here vs <1s for a 1-frame range,
        // entirely in decode time never used. This mutates ONLY the exported prompt JSON for this one queue -
        // the live OCIORead nodes' own start_frame/end_frame widgets (and the full range used by "full
        // render" via the Write nodes) are never touched. Narrowing the two INACTIVE reads too is harmless
        // (their output never reaches the switch's chosen branch) and keeps them just as fast + fresh.
        const batchWidget = boundaryNode && (widget(boundaryNode, "batch_index") || widget(boundaryNode, "preview_frame"));
        const batchOffset = batchWidget ? (Number(batchWidget.value) || 0) : 0;
        for (const readId of readTargets) {
            const srcInputs = full[readId] && full[readId].inputs;
            if (srcInputs && typeof srcInputs.start_frame === "number") {
                const targetFrame = srcInputs.start_frame + batchOffset;
                srcInputs.start_frame = targetFrame;
                srcInputs.end_frame = targetFrame;
            }
        }
        if (readTargets.length) {
            // The active read's batch now holds exactly ONE frame (index 0) - retarget the batch-select
            // node under this boundary so it still points at a valid index instead of the original
            // (now out-of-range) offset.
            const batchNodeId = Object.keys(full).find((k) => k.startsWith(prefix) && full[k].class_type === "ImageFromBatch");
            if (batchNodeId) full[batchNodeId].inputs.batch_index = 0;
        }
        // Use ComfyUI's OWN api.queuePrompt() instead of a hand-rolled fetch() - it already supports
        // partial_execution_targets as a third-argument option (found by reading the frontend bundle's
        // actual queuePrompt() source), and critically it reads client_id from `this.clientId` internally,
        // guaranteed to match THIS tab's live WebSocket connection. The earlier hand-rolled version guessed
        // at client_id (api.clientId ?? api.initialClientId ?? "") and went through a different fetch path
        // than the native Queue button - almost certainly why the button never saw "executing" progress
        // events land back on this tab (wrong/stale client_id -> server broadcasts to a socket that isn't
        // this one), no matter the actual render duration. Going through the SAME method the native Queue
        // button itself calls means this now behaves exactly like a normal queue from ComfyUI's own
        // perspective, including its event delivery.
        const data = await api.queuePrompt(0, { output: full, workflow: exported.workflow }, { partialExecutionTargets: targets });
        const promptId = data && data.prompt_id;
        if (boundaryNode && promptId) {
            // Mark this as the LATEST job this box asked for - the "executed" listener and refreshFromHistory
            // (below) both react to ANY prompt's completion, not just this click's. Without this, a SLOWER
            // older click (still queued behind this one, or left over from before a settings change) can
            // finish AFTER this one and silently overwrite a just-shown correct frame with its stale result -
            // exactly what was observed: frame 1002 rendering, then getting replaced by frame 1001 moments
            // later from an in-flight older job nobody told to stand down.
            boundaryNode.__ocioLastPromptId = promptId;
        }
        if (runWidget && promptId) {
            if (runWidget.__ocioClickSeq !== mySeq) return; // a newer click already superseded this one - don't touch anything
            runWidget.name = "⏳ Queued...";
            // Only THIS click's promptId may drive this button from here on - see mySeq's own note above for
            // why sequence number, not promptId, is the thing every check below gates on.
            runWidget.__ocioCurrentPromptId = promptId;
            RUNNING_RUN_BUTTONS.set(promptId, runWidget);
            // The "executing" WebSocket event this originally relied on has proven unreliable across several
            // fix attempts (switching to api.queuePrompt() for the correct client_id did not fully stop it),
            // and a ONE-SHOT /history check right after queuing can itself fire too early - before the job
            // has even registered - and then have nothing left to fall back on but that same unreliable
            // event. So: POLL /history short-interval instead of trusting either a single check or the WS
            // event alone. This is now the PRIMARY way the button clears; the WS listener below is a bonus
            // (clears it sooner when it does arrive), and the 2-minute setTimeout inside pollHistory is the
            // final backstop if the job is genuinely still running after all this polling.
            pollHistory(promptId, runWidget, mySeq);
        } else if (runWidget && runWidget.__ocioClickSeq === mySeq) {
            runWidget.name = "▶ Run"; // no prompt_id back - nothing to track, don't leave it stuck
        }
        app.graph.setDirtyCanvas(true, true);
        console.log(`[OCIO] runToNode: queued partial_execution_targets=[${targetId}] (prompt_id=${promptId})`);
    } catch (e) {
        console.error("[OCIO] runToNode failed", e);
        if (runWidget && runWidget.__ocioClickSeq === mySeq) { runWidget.name = "▶ Run"; app.graph.setDirtyCanvas(true, true); }
    }
}

function isSwitchBox(node) {
    const w = widget(node, "preset");
    if (!w || !w.options || !Array.isArray(w.options.values)) return false;
    const vals = w.options.values;
    return vals.length === PRESET_VALUES.length && PRESET_VALUES.every((v, i) => vals[i] === v);
}
// The three preset chains' own FINAL node (the one that actually feeds the nested "OCIO Switch In" node,
// carrying the shared in/out colorspace this box's own widgets broadcast to) - found by tracing the switch
// node's real LiteGraph input links, not by node type or title (OCIOColorSpace appears at OTHER stages
// too - e.g. the PNG chain's first, re-encode stage - and titles collide across chains: the MP4 and PNG
// final nodes are both literally titled "OCIOColorSpace1 (sRGB -> ACEScct)"). node.subgraph is confirmed
// working in this build (verified directly - broadcasting a colorspace change through this exact function
// and reading it back on the live interior nodes), unlike several other places in this file that avoid it.
function findPresetChainFinalNodes(node) {
    const g = node.subgraph;
    if (!g) return [];
    const nodes = g._nodes || g.nodes || [];
    const switchNode = nodes.find((n) => n.title === "OCIO Switch In (EXR/PNG/MP4)");
    if (!switchNode || !switchNode.inputs || !g.links) return [];
    const seen = new Set();
    const result = [];
    for (const inp of switchNode.inputs) {
        if (inp.link == null) continue;
        const link = g.links[inp.link];
        if (!link) continue;
        const srcNode = nodes.find((n) => n.id === link.origin_id);
        if (srcNode && !seen.has(srcNode.id)) { seen.add(srcNode.id); result.push(srcNode); }
    }
    return result;
}
function propagateSharedColorspace(node, widgetName, value) {
    for (const chainNode of findPresetChainFinalNodes(node)) {
        const w = (chainNode.widgets || []).find((ww) => ww.name === widgetName);
        if (!w || w.value === value) continue;
        w.value = value;
        if (w.callback) w.callback(value);
    }
}
// The interior "Thumbnail" PreviewImage node (135) - same node.subgraph traversal as above.
function findThumbnailNode(node) {
    const g = node.subgraph;
    if (!g) return null;
    const nodes = g._nodes || g.nodes || [];
    return nodes.find((n) => n.type === "PreviewImage") || null;
}
// The "First frame only" ImageFromBatch node (134) feeding the Thumbnail - its own `batch_index` decides
// WHICH frame of whatever chain is currently selected gets shown. Sits downstream of all four chains (the
// switch already picked one by the time it reaches here), so unlike SHARED_COLORSPACE_WIDGETS this is a
// single target, not three - no propagation loop needed, just one widget to keep in sync.
function findThumbnailBatchNode(node) {
    const g = node.subgraph;
    if (!g) return null;
    const nodes = g._nodes || g.nodes || [];
    return nodes.find((n) => n.type === "ImageFromBatch") || null;
}
// `preview` (promoted from the Manual node) used to just toggle Manual's OWN on-node preview - dead weight
// now that every interior node's own preview is permanently off (see the "why 6 previews" fix), since
// Manual's preview flag was never wired to anything the box actually shows. Repurposed here to control
// whether the box's real preview mechanism, the Thumbnail node, runs at all: ACTIVE when on, NEVER (muted)
// when off. PreviewImage has no "off" input of its own to drive instead, so gating it by mode is the only
// lever available.
function applyPreviewEnabled(node, enabled) {
    const thumb = findThumbnailNode(node);
    if (!thumb) return;
    const NEVER = (window.LiteGraph && window.LiteGraph.NEVER) ?? 2;
    const ACTIVE = (window.LiteGraph && window.LiteGraph.ALWAYS) ?? 0;
    thumb.mode = enabled ? ACTIVE : NEVER;
}
function imgsFromOutput(output) {
    if (!output || !Array.isArray(output.images) || !output.images.length) return null;
    return output.images.map((img) => {
        const el = new Image();
        const params = new URLSearchParams({
            filename: img.filename,
            type: img.type || "temp",
            subfolder: img.subfolder || "",
            // Cache-bust: a "temp" PreviewImage output's filename is not guaranteed unique across every
            // click in a long session (ComfyUI's own temp counter can repeat), and this <img> fetch has no
            // Cache-Control header of its own to rely on - a browser HTTP cache hit on a REUSED filename
            // would silently serve yesterday's (or ten clicks ago's) bytes for today's request. rndid ties
            // every fetch to a value that is unique per call, so a same-named-but-different file can never
            // be served from cache.
            rndid: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
        });
        el.src = api.apiURL(`/view?${params.toString()}`);
        return el;
    });
}
const THUMB_H = 160;
// Paint the thumbnail onto the node's OWN canvas area directly, instead of relying on the native .imgs
// rendering path a plain leaf node gets for free - a subgraph's collapsed boundary node has a wholly
// different, custom renderer built around showing input/output sockets, which may simply never look at
// .imgs at all no matter how correctly it is set. This bypasses that uncertainty entirely: reserve a fixed
// band at the bottom of the box (once, guarded by __ocioThumbSpace) and draw into it ourselves every frame.
//
// Run used to live here too, as a custom-drawn button below the picture - two attempts at getting its click
// handling right (repositioning it, then insetting it away from LiteGraph's bottom-right resize grip) both
// failed to fix it, which points to something more fundamental about mouse-event dispatch on this node type
// that is not just a hit-box math error. Reverted to a plain addWidget("button", ...) instead (added in
// addMissingChrome) - the same mechanism upload/swap/viewer all use reliably - trading its exact position
// below the image for something that actually responds to clicks.
function installThumbDrawer(node) {
    if (node.__ocioThumbSpace) return;
    node.__ocioThumbSpace = true;
    // widgets_start_y (LiteGraph's official "reserve space above the widget stack" property) turned out NOT
    // to be respected by this subgraph boundary node type - the banner drew fine, but the widgets stayed put
    // at their original position instead of being pushed down, so the first widget's text overlapped/sat on
    // top of the banner instead of below it. This node type's rendering has consistently diverged from plain
    // LGraphNode behaviour all session (the same reason .imgs never worked for the thumbnail either), so
    // instead of trusting another "should just work" convention, push each widget down by BANNER_H directly
    // and explicitly add BANNER_H to the computed size myself - no assumptions about what the base
    // implementation does or does not already account for.
    const baseComputeSize = node.computeSize.bind(node);
    node.computeSize = function (...args) {
        const s = baseComputeSize(...args);
        s[1] += BANNER_H;
        if (!this.__ocioThumbHidden) s[1] += THUMB_H;
        // Empirically confirmed (via user screenshot + live trial: 60 too much, 50 too much, 40 exact) -
        // baseComputeSize()'s own widget-row accounting runs ~40px taller than this node type's actual
        // rendered row spacing, leaving a dead gap between the last widget ("Run") and the thumbnail band
        // below it. Not fully root-caused (baseComputeSize is a black box on this subgraph boundary node
        // type, same as widgets_start_y and slot `.pos` before it), but this correction is confirmed exact
        // at the current widget count (13 rows) - if a widget is added/removed later and the gap
        // reappears or overshoots, this constant needs re-tuning against the new row count.
        s[1] -= 40;
        return s;
    };
    const orig = node.onDrawForeground;
    node.onDrawForeground = function (ctx) {
        // Shift every widget down by BANNER_H exactly once (per widget, tracked individually since new
        // widgets can appear later via addMissingChrome) - done here, every frame, rather than once at
        // install time, for the same reason the grey-state enforcement below is per-frame: something
        // resetting widget layout between frames would otherwise silently undo a one-time shift.
        for (const w of this.widgets || []) {
            if (w.__ocioBannerShifted) continue;
            w.y = (w.y || 0) + BANNER_H;
            w.__ocioBannerShifted = true;
        }
        // Cleanup for a now-reverted experiment: a per-slot `.pos` override was briefly set here to try
        // pushing the input/output row down, then removed again - but by then it had already been baked
        // into the saved workflow (LiteGraph serializes whatever custom properties sit on an input/output
        // object). On reload that stale `.pos` makes ONE render path (the generic connector/link code,
        // which does respect it) draw the slot at the shifted spot, while this node's own custom label
        // renderer (which never respected it) still draws the SAME label at its normal formulaic position -
        // two overlapping copies of "OCIO Img/Seq/Vid" / "ComfyUI Video" smeared on top of each other. Strip
        // it every frame so it can never resurface, however it got there.
        for (const list of [this.inputs, this.outputs]) {
            if (!list) continue;
            for (const slot of list) {
                if (slot && slot.pos) delete slot.pos;
            }
        }
        const r = orig ? orig.apply(this, arguments) : undefined;
        if (!(this.flags && this.flags.collapsed) && BANNER_IMG.complete && BANNER_IMG.naturalWidth) {
            // Uniform scale to fit BANNER_H, centered horizontally - NOT stretched to fill the width
            // independently on each axis, which distorted circular elements in the logo into ellipses
            // (scaleY != scaleX whenever the node's width-to-30px ratio doesn't exactly match the source
            // image's own aspect ratio, which it essentially never will as the node gets resized).
            const scale = BANNER_H / BANNER_IMG.naturalHeight;
            const w = BANNER_IMG.naturalWidth * scale;
            const x = (this.size[0] - w) / 2;
            // Clipped to the node's own width - nothing constrained this before, so a banner wider than a
            // narrowed/shrunk node (or one pulled up far enough to sit partly over the rounded title-bar
            // corners) could spill past the left/right edges onto the canvas background.
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, BANNER_Y, this.size[0], BANNER_H);
            ctx.clip();
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(BANNER_IMG, x, BANNER_Y, w, BANNER_H);
            ctx.restore();
        }
        // Enforce the grey state every single frame, unconditionally - not only when the preset value
        // changes. Two independent things can silently undo it between frames: (1) subgraph widget
        // promotion may replace/reset the widget object after nodeCreated runs, breaking a wrapped callback
        // (the same class of bug that broke the live preview earlier), and (2) something elsewhere in
        // ComfyUI (unrelated graph edits triggering a widget re-sync) can reset a widget's own .disabled
        // flag directly without going through any of this code - a "value changed" check would never catch
        // that, since the value itself never changed, only the flag something else touched. Always
        // re-applying is cheap (a handful of property writes) and immune to both. redraw:false so this does
        // not itself trigger setDirtyCanvas every frame, which would spin the canvas at max refresh rate.
        installPresetTint(this);
        const presetW = widget(this, "preset");
        if (presetW) applyGray(this, presetW.value, false);
        // Mirror this box's own `preset` onto the root-level "Source Switch Select" node (see the
        // ocio.source.switch.testing block below) so ONE combo drives everything instead of two synced by
        // hand - same per-frame change-detection pattern as the colorspace broadcast above, needed for the
        // same reason: a promoted widget's callback can get silently replaced. The two combos share the
        // exact same option set (Manual/EXR/PNG/MP4), so this is a direct value copy, no translation.
        if (presetW && presetW.value !== this.__ocioLastRootPreset) {
            this.__ocioLastRootPreset = presetW.value;
            const switchNode = (app.graph._nodes || []).find((n) => n.title === SOURCE_SWITCH_TITLE);
            const sw = switchNode && widget(switchNode, "preset");
            if (sw && sw.value !== presetW.value) {
                sw.value = presetW.value;
                if (sw.callback) sw.callback(presetW.value);
            }
        }
        // Same per-frame change-detection, this time to broadcast in_colorspace/out_colorspace onto all
        // three preset chains' final node whenever you edit them here - see SHARED_COLORSPACE_WIDGETS above.
        this.__ocioLastShared = this.__ocioLastShared || {};
        for (const name of SHARED_COLORSPACE_WIDGETS) {
            const w = widget(this, name);
            if (!w || w.value === this.__ocioLastShared[name]) continue;
            this.__ocioLastShared[name] = w.value;
            propagateSharedColorspace(this, name, w.value);
        }
        // Same pattern again for `preview`, now repurposed to gate the Thumbnail node's mode - see
        // applyPreviewEnabled above for why this no longer touches Manual's own (permanently-off) preview.
        const previewW = widget(this, "preview");
        if (previewW && previewW.value !== this.__ocioLastPreviewEnabled) {
            this.__ocioLastPreviewEnabled = previewW.value;
            applyPreviewEnabled(this, previewW.value);
        }
        // `preview_frame` repurposed the same way `preview` was: no longer just a value riding along to
        // Manual's own on-node preview, also drives which frame the box's real Thumbnail shows, via the
        // "First frame only" ImageFromBatch node's `batch_index`. STRING -> INT here for the same reason
        // OCIOColorSpace.convert() parses it server-side: blank/junk means frame 0, never a hard error.
        const frameW = widget(this, "preview_frame");
        if (frameW && frameW.value !== this.__ocioLastFrame) {
            this.__ocioLastFrame = frameW.value;
            const batchNode = findThumbnailBatchNode(this);
            const bw = batchNode && (batchNode.widgets || []).find((w) => w.name === "batch_index");
            if (bw) {
                const parsed = parseInt(String(frameW.value).trim(), 10);
                const v = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
                if (bw.value !== v) {
                    bw.value = v;
                    if (bw.callback) bw.callback(v);
                }
            }
        }
        // A same-session self-heal attempt here (auto-correcting size[1] to match computeSize() every
        // frame) was REVERTED - computeSize()'s own baseComputeSize call reads the widgets' CURRENT (already
        // +BANNER_H-shifted) .y positions, so once the shift has happened once, the wrapper's own separate
        // "+= BANNER_H" on top very likely double-counts that space. Enforcing that inflated number every
        // frame turned a fixable stale-size bug into a permanent dead gap between Run and the thumbnail.
        // Left as a manual panel_resize_node fix (imperfect, but does not actively make it worse) until the
        // double-count can be confirmed and fixed at the source.
        if (this.flags && this.flags.collapsed) return r;
        if (this.__ocioThumbHidden) return r;
        const pad = 6;
        const img = this.__ocioThumb;
        const areaW = this.size[0] - pad * 2;
        const areaH = THUMB_H - pad * 2;
        const areaY = this.size[1] - THUMB_H + pad;
        ctx.save();
        ctx.fillStyle = "#111";
        ctx.fillRect(pad, areaY, areaW, areaH);
        if (img && img.complete && img.naturalWidth) {
            const scale = Math.min(areaW / img.naturalWidth, areaH / img.naturalHeight);
            const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
            const x = pad + (areaW - w) / 2, y = areaY + (areaH - h) / 2;
            ctx.drawImage(img, x, y, w, h);
        }
        ctx.restore();
        return r;
    };
}
function refreshBoundaryPreview(node, imgs) {
    node.__ocioThumb = imgs[0];
    node.__ocioThumbHidden = false;
    const toggle = widget(node, "▾ Viewer");
    if (toggle) toggle.name = "▾ Viewer";
    node.setSize([node.size[0], node.computeSize()[1]]);
    node.setDirtyCanvas(true, true);
}

app.registerExtension({
    name: "ocio.switch.select.gray",
    nodeCreated(node) {
        if (!isSwitchBox(node)) return;
        installThumbDrawer(node);
        addMissingChrome(node);
        installPresetTint(node);
        applyGray(node, widget(node, "preset").value);
        const w = widget(node, "preset");
        const orig = w.callback;
        w.callback = (v, ...rest) => {
            const r = orig ? orig.call(w, v, ...rest) : undefined;
            applyGray(node, v);
            return r;
        };
    },
});

// Show the preview on the collapsed boundary node the instant it is ready, without needing a "▾ Viewer"
// click first. ComfyUI addresses a nested subgraph node's execution result with a compound id
// ("<boundary_id>:<interior_id>", e.g. "110:135"), and fires a global "executed" event per node - not just
// the top-level ones - so this can react directly instead of polling or waiting for a manual toggle.
//
// Earlier this read the image back off the interior "Thumbnail" node's own .imgs via node.subgraph - that
// property was never confirmed to actually exist on a subgraph boundary node in this ComfyUI build, so if it
// didn't, this whole path silently did nothing every single run, which matches what was actually observed
// (no image, ever). Fixed to build the <img> elements directly from THIS event's own detail.output.images
// instead - the same {filename, subfolder, type} shape every ComfyUI image output uses - which needs nothing
// from node.subgraph at all.
//
// MUST filter to the Thumbnail node's OWN interior id (135), not "any image-carrying event under this box's
// id". That used to be safe when every other interior node's preview was off, but 122/125/120 (the EXR/PNG/MP4
// recipe chains' final OCIOColorSpace) now also have preview=true (to match a known-good reference workflow's
// on-node preview behaviour) - and since the switch structure means ALL THREE recipe chains execute on every
// run regardless of which one is selected, all three ALSO fire their own "executed" event with images for
// the SAME prompt. Without this filter, whichever of those four events happens to arrive LAST wins the box's
// on-canvas thumbnail - not necessarily the one the switch actually selected. Confirmed live: the box showed
// PNG's own un-selected raw preview with visibly different contrast from the correct switched-through EXR
// result, while the actual PreviewImage (135) output measured pixel-identical to the reference the whole time.
const THUMBNAIL_INNER_ID = "135";
api.addEventListener("executed", (e) => {
    const detail = e.detail;
    if (!detail || detail.node == null) return;
    const parts = String(detail.node).split(":");
    if (parts.length < 2) return;
    const boundaryId = parts[0];
    if (parts[parts.length - 1] !== THUMBNAIL_INNER_ID) return;
    const host = (app.graph._nodes || []).find((n) => String(n.id) === String(boundaryId));
    if (!host || !isSwitchBox(host)) return;
    // Ignore a stale/superseded job - see the note where __ocioLastPromptId is set in runToNode. A box
    // that has never been run through OUR button (native "Queue Prompt" only) has no __ocioLastPromptId,
    // so this stays unrestricted for that case.
    if (host.__ocioLastPromptId && detail.prompt_id && String(host.__ocioLastPromptId) !== String(detail.prompt_id)) return;
    const imgs = imgsFromOutput(detail.output);
    if (!imgs) return;
    refreshBoundaryPreview(host, imgs);
});

// FALLBACK for the common case above: a CACHED node (inputs unchanged since the last run - e.g. testing the
// same preset twice in a row) does not re-execute, so it very likely never fires "executed" at all, even
// though ComfyUI's own /history API still reports its output correctly (cached or not - confirmed directly:
// GET /history/<id> listed "110:135" as both a cached node AND a real output entry in the same response).
// This hits that same endpoint once the whole queued prompt finishes ("executing" with node:null is
// ComfyUI's own signal for that), then checks every CoSA_OCIO box on the graph for the Thumbnail's OWN key
// ("<box id>:135") - NOT just any key starting with "<box id>:", for the exact reason THUMBNAIL_INNER_ID
// exists on the "executed" listener above: 122/125/120 (the recipe chains) also carry images under this
// box's id prefix now that their own preview is on, and a plain prefix match could pick up an UN-selected
// chain's own preview instead of the Thumbnail's actual switched-through result.
async function refreshFromHistory(promptId) {
    try {
        const resp = await fetch(api.apiURL(`/history/${promptId}`));
        const data = await resp.json();
        const entry = data[promptId];
        if (!entry || !entry.outputs) { console.warn("[OCIO] refreshFromHistory: no outputs for", promptId); return; }
        let matched = 0;
        for (const node of (app.graph._nodes || [])) {
            if (!isSwitchBox(node)) continue;
            // Same staleness guard as the "executed" listener above - a slower older job's history fetch
            // must not overwrite what a newer click already correctly displayed for this box.
            if (node.__ocioLastPromptId && String(node.__ocioLastPromptId) !== String(promptId)) continue;
            const key = `${node.id}:${THUMBNAIL_INNER_ID}`;
            const found = (
                entry.outputs[key] && Array.isArray(entry.outputs[key].images) && entry.outputs[key].images.length
            );
            if (!found) continue;
            const imgs = imgsFromOutput(entry.outputs[key]);
            if (imgs) { refreshBoundaryPreview(node, imgs); matched++; }
        }
        console.log(`[OCIO] refreshFromHistory: updated ${matched} box(es) from prompt ${promptId}`);
    } catch (e) {
        console.error("[OCIO] refreshFromHistory failed", e);
    }
}
api.addEventListener("executing", (e) => {
    const detail = e.detail;
    const promptId = detail && typeof detail === "object" ? detail.prompt_id : detail;
    const node = detail && typeof detail === "object" ? detail.node : undefined;
    // Reflect progress on the OCIO "▶ Run" button for THIS prompt_id, if any is tracked - node non-null
    // means it actually started executing (as opposed to still sitting in the queue behind other jobs,
    // which is what made a click look like nothing was happening); node null means the whole prompt is
    // done, so the button resets and stops being tracked either way.
    const trackedBtn = promptId ? RUNNING_RUN_BUTTONS.get(promptId) : null;
    // Ignore this event if a NEWER click already superseded it (see runToNode's own note on the race this
    // guards against) - the button's __ocioCurrentPromptId always names the click that owns it right now.
    if (trackedBtn && trackedBtn.__ocioCurrentPromptId === promptId) {
        if (node !== null) {
            if (trackedBtn.name !== "⏳ Running...") { trackedBtn.name = "⏳ Running..."; app.graph.setDirtyCanvas(true, true); }
        } else {
            trackedBtn.name = "▶ Run";
            RUNNING_RUN_BUTTONS.delete(promptId);
            app.graph.setDirtyCanvas(true, true);
        }
    } else if (trackedBtn) {
        RUNNING_RUN_BUTTONS.delete(promptId); // stale entry for a superseded click - stop tracking it, don't touch the button
    }
    if (node !== null) return; // null node = the whole queued prompt just finished, not one node
    if (!promptId) return;
    refreshFromHistory(promptId);
});

// ---- Testing-only: single-combo root-level source switch (added on request) -------------------------------
// A root-level "Source Switch Select" node (OCIOSwitchSelect) already routes DATA into #110 via its
// inner_select output feeding a ThreeWaySwitch across the three OCIORead nodes. That alone does not stop the
// other two readers from computing - a separate OCIOPresetControl node handled that half by muting the
// other readers' groups, but needing TWO synced combos for one decision was the complaint ("I don't want to
// have to set to toggles. just one"). This folds both jobs into the ONE combo instead: reuses the exact
// group-matching approach ocio.preset.control (ocio_io.js) already uses for OCIOPresetControl nodes,
// duplicated here in miniature rather than exported cross-module (that file's helpers are not exported),
// scoped ONLY to a node titled exactly "Source Switch Select" so it can never affect #110's own internal
// OCIOSwitchSelect (node 129) or any other instance of this node type elsewhere in the graph.
const SOURCE_SWITCH_TITLE = "Source Switch Select";
const SOURCE_GROUP_PATTERNS = { EXR: /EXR/i, PNG: /PNG/i, MP4: /MP4/i };
function applySourceSwitchGroups(preset) {
    const graph = app.graph;
    const groups = (graph && graph._groups) || [];
    const NEVER = (window.LiteGraph && window.LiteGraph.NEVER) ?? 2;
    const ACTIVE = (window.LiteGraph && window.LiteGraph.ALWAYS) ?? 0;
    for (const [key, re] of Object.entries(SOURCE_GROUP_PATTERNS)) {
        const active = key === preset; // "Manual" (or anything unrecognized) mutes every reader group
        for (const g of groups) {
            if (!re.test(g.title || "")) continue;
            const b = g._bounding;
            if (!b) continue;
            for (const n of (graph._nodes || [])) {
                if (!n.pos || !n.size) continue;
                const cx = n.pos[0] + n.size[0] / 2, cy = n.pos[1] + n.size[1] / 2;
                if (cx >= b[0] && cx < b[0] + b[2] && cy >= b[1] && cy < b[1] + b[3]) {
                    n.mode = active ? ACTIVE : NEVER;
                }
            }
        }
    }
    graph.setDirtyCanvas(true, true);
}
app.registerExtension({
    name: "ocio.source.switch.testing",
    nodeCreated(node) {
        if (node.title !== SOURCE_SWITCH_TITLE) return;
        const w = widget(node, "preset");
        if (!w) return;
        const orig = w.callback;
        w.callback = (v, ...rest) => {
            const r = orig ? orig.call(w, v, ...rest) : undefined;
            applySourceSwitchGroups(v);
            return r;
        };
        applySourceSwitchGroups(w.value);
    },
});
