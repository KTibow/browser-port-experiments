/* Emscripten surface for browser-port-experiments NetSurf framebuffer.
 *
 * This file is copied into libnsfb by scripts/build-framebuffer-wasm.sh.
 * It intentionally stays source-like (rather than embedded in a shell heredoc)
 * so cursor hooks, input shims, and dirty-rect behaviour can be reviewed and
 * tested independently of the relay script plumbing.
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

#include "libnsfb.h"
#include "libnsfb_event.h"
#include "libnsfb_plot.h"

#include "nsfb.h"
#include "surface.h"
#include "plot.h"
#include "cursor.h"

#define EVENT_QUEUE_LENGTH 128

static nsfb_event_t event_queue[EVENT_QUEUE_LENGTH];
static unsigned int event_read = 0;
static unsigned int event_write = 0;

#ifdef __EMSCRIPTEN__
static nsfb_t *pending_update_nsfb = NULL;
static nsfb_bbox_t pending_update_box;
static bool pending_update_scheduled = false;
#endif

static bool queue_push(nsfb_event_t event)
{
    unsigned int next = (event_write + 1) % EVENT_QUEUE_LENGTH;
    if (next == event_read) {
        return false;
    }
    event_queue[event_write] = event;
    event_write = next;
    return true;
}

static bool queue_pop(nsfb_event_t *event)
{
    if (event_read == event_write) {
        return false;
    }
    *event = event_queue[event_read];
    event_read = (event_read + 1) % EVENT_QUEUE_LENGTH;
    return true;
}

static bool clamp_box(nsfb_t *nsfb, nsfb_bbox_t *box)
{
    if (box->x0 < 0) box->x0 = 0;
    if (box->y0 < 0) box->y0 = 0;
    if (box->x1 > nsfb->width) box->x1 = nsfb->width;
    if (box->y1 > nsfb->height) box->y1 = nsfb->height;
    return box->x1 > box->x0 && box->y1 > box->y0;
}

static void union_box(nsfb_bbox_t *target, const nsfb_bbox_t *source)
{
    if (source->x0 < target->x0) target->x0 = source->x0;
    if (source->y0 < target->y0) target->y0 = source->y0;
    if (source->x1 > target->x1) target->x1 = source->x1;
    if (source->y1 > target->y1) target->y1 = source->y1;
}

#ifdef __EMSCRIPTEN__
EM_JS(void, netsurf_emscripten_surface_update_js, (int ptr, int stride, int width, int height, int x, int y, int w, int h), {
    if (Module.netsurfOnFramebufferUpdate) {
        Module.netsurfOnFramebufferUpdate(ptr, stride, width, height, x, y, w, h);
    }
});

EM_JS(void, netsurf_emscripten_surface_cursor_js, (int x0, int y0, int x1, int y1, int hotspot_x, int hotspot_y, int plotted), {
    if (Module.netsurfOnCursorUpdate) {
        Module.netsurfOnCursorUpdate(x0, y0, x1, y1, hotspot_x, hotspot_y, !!plotted);
    }
});

static void flush_pending_update(void *user_data)
{
    nsfb_t *nsfb = pending_update_nsfb;
    nsfb_bbox_t box = pending_update_box;
    (void)user_data;

    pending_update_nsfb = NULL;
    pending_update_scheduled = false;

    if (nsfb == NULL || nsfb->ptr == NULL || !clamp_box(nsfb, &box)) {
        return;
    }

    netsurf_emscripten_surface_update_js(
        (int)(uintptr_t)nsfb->ptr,
        nsfb->linelen,
        nsfb->width,
        nsfb->height,
        box.x0,
        box.y0,
        box.x1 - box.x0,
        box.y1 - box.y0);
}
#endif

static int emscripten_defaults(nsfb_t *nsfb)
{
    nsfb->width = 640;
    nsfb->height = 480;
    nsfb->format = NSFB_FMT_XRGB8888;
    select_plotters(nsfb);
    return 0;
}

static int emscripten_initialise(nsfb_t *nsfb)
{
    size_t size = (nsfb->width * nsfb->height * nsfb->bpp) / 8;
    uint8_t *fbptr = realloc(nsfb->ptr, size);
    if (fbptr == NULL) {
        return -1;
    }

    nsfb->ptr = fbptr;
    nsfb->linelen = (nsfb->width * nsfb->bpp) / 8;
    return 0;
}

static int emscripten_finalise(nsfb_t *nsfb)
{
    free(nsfb->ptr);
    nsfb->ptr = NULL;
    return 0;
}

static int emscripten_set_geometry(nsfb_t *nsfb, int width, int height, enum nsfb_format_e format)
{
    int startsize = (nsfb->width * nsfb->height * nsfb->bpp) / 8;
    int prev_width = nsfb->width;
    int prev_height = nsfb->height;
    enum nsfb_format_e prev_format = nsfb->format;

    if (width > 0) nsfb->width = width;
    if (height > 0) nsfb->height = height;
    if (format != NSFB_FMT_ANY) nsfb->format = format;

    select_plotters(nsfb);

    if (nsfb->ptr != NULL) {
        int endsize = (nsfb->width * nsfb->height * nsfb->bpp) / 8;
        if (startsize != endsize) {
            uint8_t *fbptr = realloc(nsfb->ptr, endsize);
            if (fbptr == NULL) {
                nsfb->width = prev_width;
                nsfb->height = prev_height;
                nsfb->format = prev_format;
                select_plotters(nsfb);
                return -1;
            }
            nsfb->ptr = fbptr;
        }
    }

    nsfb->linelen = (nsfb->width * nsfb->bpp) / 8;
    return 0;
}

static bool emscripten_input(nsfb_t *nsfb, nsfb_event_t *event, int timeout)
{
    (void)nsfb;
    (void)timeout;
    return queue_pop(event);
}

static int emscripten_update(nsfb_t *nsfb, nsfb_bbox_t *box)
{
    nsfb_bbox_t clipped = *box;

    if (nsfb->ptr == NULL || !clamp_box(nsfb, &clipped)) {
        return 0;
    }

#ifdef __EMSCRIPTEN__
    if (pending_update_nsfb == nsfb && pending_update_scheduled) {
        union_box(&pending_update_box, &clipped);
    } else {
        pending_update_nsfb = nsfb;
        pending_update_box = clipped;
        pending_update_scheduled = true;
        emscripten_async_call(flush_pending_update, NULL, 0);
    }
#else
    (void)clipped;
#endif
    return 0;
}

static int emscripten_cursor(nsfb_t *nsfb, struct nsfb_cursor_s *cursor)
{
    nsfb_bbox_t box;

    if (cursor == NULL) {
        return 0;
    }

    box = cursor->loc;
#ifdef __EMSCRIPTEN__
    netsurf_emscripten_surface_cursor_js(
        box.x0,
        box.y0,
        box.x1,
        box.y1,
        cursor->hotspot_x,
        cursor->hotspot_y,
        cursor->plotted ? 1 : 0);
#endif

    if (clamp_box(nsfb, &box)) {
        return emscripten_update(nsfb, &box);
    }
    return 0;
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
int netsurf_framebuffer_push_key(int down, int keycode)
{
    nsfb_event_t event;
    event.type = down ? NSFB_EVENT_KEY_DOWN : NSFB_EVENT_KEY_UP;
    event.value.keycode = (enum nsfb_key_code_e)keycode;
    return queue_push(event) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
int netsurf_framebuffer_push_mouse(int down, int button)
{
    int keycode = NSFB_KEY_MOUSE_1;
    nsfb_event_t event;
    if (button == 1) keycode = NSFB_KEY_MOUSE_2;
    if (button == 2) keycode = NSFB_KEY_MOUSE_3;
    event.type = down ? NSFB_EVENT_KEY_DOWN : NSFB_EVENT_KEY_UP;
    event.value.keycode = (enum nsfb_key_code_e)keycode;
    return queue_push(event) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
int netsurf_framebuffer_push_motion(int x, int y)
{
    nsfb_event_t event;
    event.type = NSFB_EVENT_MOVE_ABSOLUTE;
    event.value.vector.x = x;
    event.value.vector.y = y;
    event.value.vector.z = 0;
    return queue_push(event) ? 1 : 0;
}
#endif

const nsfb_surface_rtns_t emscripten_rtns = {
    .defaults = emscripten_defaults,
    .initialise = emscripten_initialise,
    .finalise = emscripten_finalise,
    .input = emscripten_input,
    .geometry = emscripten_set_geometry,
    .update = emscripten_update,
    .cursor = emscripten_cursor,
};

NSFB_SURFACE_DEF(emscripten, NSFB_SURFACE_EMSCRIPTEN, &emscripten_rtns)
