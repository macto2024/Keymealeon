#pragma once
#include <clib/u8g2.h>
namespace Keymaeleon6 {
// Called before begin()/drawing. Default identical U8g2 constructors share a
// static framebuffer and the fast SSD13xx CAD callback shares transfer state.
inline void isolateDisplay(u8g2_t *display, uint8_t *ownedFramebuffer) {
  display->tile_buf_ptr = ownedFramebuffer;
  u8g2_GetU8x8(display)->cad_cb = u8x8_cad_ssd13xx_i2c;
}
}
