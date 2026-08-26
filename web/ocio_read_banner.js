// ComfyUI-OCIO - CoSA banner on "CoSA OCIO Read 1.0" (OCIORead) nodes. Same look as the switch box's
// banner in ocio_switch_select.js: cosa_banner.png drawn ABOVE the node (BANNER_Y negative, node-local
// coords), uniformly scaled to BANNER_H and centered/clipped to the node's width. Unlike the switch box,
// no widget shifting and no slot surgery - OCIORead's own custom viewport renderer is left alone; the
// banner floats outside the node bounds so it cannot collide with any of it.
import { app } from "../../scripts/app.js";

const BANNER_H = 30;
const BANNER_Y = -60;   // above the title bar, same confirmed-good offset as the switch box
const BANNER_IMG = new Image();
BANNER_IMG.src = new URL("cosa_banner.png", import.meta.url).href;

app.registerExtension({
    name: "ComfyUI-OCIO.read_banner",
    async nodeCreated(node) {
        if (node?.comfyClass !== "OCIORead" && node?.type !== "OCIORead") return;
        if (node.__cosaBannerAdded) return;
        node.__cosaBannerAdded = true;
        const orig = node.onDrawForeground;
        node.onDrawForeground = function (ctx) {
            const r = orig ? orig.apply(this, arguments) : undefined;
            if (!(this.flags && this.flags.collapsed) && BANNER_IMG.complete && BANNER_IMG.naturalWidth) {
                const scale = BANNER_H / BANNER_IMG.naturalHeight;
                const w = BANNER_IMG.naturalWidth * scale;
                const x = (this.size[0] - w) / 2;
                ctx.save();
                ctx.beginPath();
                ctx.rect(0, BANNER_Y, this.size[0], BANNER_H);
                ctx.clip();
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = "high";
                ctx.drawImage(BANNER_IMG, x, BANNER_Y, w, BANNER_H);
                ctx.restore();
            }
            return r;
        };
    },
});
