// Minimal libnsfb RAM-surface canvas bridge probe for wasm32-emscripten.
// This does not run the full NetSurf browser yet; it proves the framebuffer
// pixels produced in NetSurf's libnsfb RAM surface can be exported to JS and
// copied into an HTML canvas.

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

#include <emscripten/emscripten.h>

#include "libnsfb.h"
#include "libnsfb_plot.h"

static nsfb_t *probe_fb;
static uint8_t *probe_buffer;
static int probe_width;
static int probe_height;
static int probe_stride;

static nsfb_colour_t rgb(uint8_t r, uint8_t g, uint8_t b)
{
    // libnsfb colours are ABGR in a uint32_t. On little-endian wasm memory the
    // bytes are R,G,B,A, exactly what Canvas ImageData wants.
    return 0xff000000u | ((nsfb_colour_t)b << 16) | ((nsfb_colour_t)g << 8) | r;
}

EMSCRIPTEN_KEEPALIVE
int netsurf_canvas_probe_init(int width, int height)
{
    if (width <= 0 || height <= 0) {
        return -1;
    }

    if (probe_fb != NULL) {
        nsfb_free(probe_fb);
        probe_fb = NULL;
        probe_buffer = NULL;
    }

    probe_fb = nsfb_new(NSFB_SURFACE_RAM);
    if (probe_fb == NULL) {
        return -2;
    }

    if (nsfb_set_geometry(probe_fb, width, height, NSFB_FMT_ABGR8888) != 0) {
        nsfb_free(probe_fb);
        probe_fb = NULL;
        return -3;
    }

    if (nsfb_init(probe_fb) != 0) {
        nsfb_free(probe_fb);
        probe_fb = NULL;
        return -4;
    }

    probe_width = width;
    probe_height = height;
    if (nsfb_get_buffer(probe_fb, &probe_buffer, &probe_stride) != 0 || probe_buffer == NULL) {
        nsfb_free(probe_fb);
        probe_fb = NULL;
        probe_buffer = NULL;
        return -5;
    }

    return 0;
}

EMSCRIPTEN_KEEPALIVE
int netsurf_canvas_probe_render(int tick)
{
    if (probe_fb == NULL || probe_buffer == NULL) {
        return -1;
    }

    for (int y = 0; y < probe_height; y++) {
        uint8_t *row = probe_buffer + (y * probe_stride);
        for (int x = 0; x < probe_width; x++) {
            uint8_t *px = row + (x * 4);
            px[0] = (uint8_t)((x + tick) & 0xff);
            px[1] = (uint8_t)((y * 2) & 0xff);
            px[2] = (uint8_t)(((x ^ y) + tick * 3) & 0xff);
            px[3] = 255;
        }
    }

    nsfb_bbox_t banner = { 24, 24, probe_width - 24, 96 };
    nsfb_plot_rectangle_fill(probe_fb, &banner, rgb(20, 32, 48));
    nsfb_plot_rectangle(probe_fb, &banner, 3, rgb(79, 209, 197), false, false);

    nsfb_bbox_t red = { 44, 44, 164, 76 };
    nsfb_bbox_t green = { 184, 44, 304, 76 };
    nsfb_bbox_t blue = { 324, 44, 444, 76 };
    nsfb_plot_rectangle_fill(probe_fb, &red, rgb(255, 83, 83));
    nsfb_plot_rectangle_fill(probe_fb, &green, rgb(80, 220, 120));
    nsfb_plot_rectangle_fill(probe_fb, &blue, rgb(80, 140, 255));

    nsfb_plot_pen_t pen = {
        .stroke_type = NFSB_PLOT_OPTYPE_SOLID,
        .stroke_width = 4,
        .stroke_colour = rgb(255, 255, 255),
        .fill_type = NFSB_PLOT_OPTYPE_NONE,
    };
    nsfb_bbox_t line = { 32, probe_height - 40, probe_width - 32, 112 };
    nsfb_plot_line(probe_fb, &line, &pen);

    nsfb_bbox_t dirty = { 0, 0, probe_width, probe_height };
    nsfb_update(probe_fb, &dirty);
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int netsurf_canvas_probe_ptr(void) { return (int)(uintptr_t)probe_buffer; }

EMSCRIPTEN_KEEPALIVE
int netsurf_canvas_probe_width(void) { return probe_width; }

EMSCRIPTEN_KEEPALIVE
int netsurf_canvas_probe_height(void) { return probe_height; }

EMSCRIPTEN_KEEPALIVE
int netsurf_canvas_probe_stride(void) { return probe_stride; }
