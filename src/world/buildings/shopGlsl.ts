// Storefront interiors (window kind 2) + street reflections for all clear glass.
// Included into the glass material after WINDOW_GLSL (uses wh1/wh2, uNight, uLamp, gDayIrr).
//
// Shop category is encoded in the fractional muntin value of store glass: muntin + cat * 0.05.
//   0 shelves (gifts/books/market/general)   1 food & drink (cafe/diner/bar/restaurant)
//   2 clothing (racks, mannequins)            3 office/bank/services (desks, partitions)
//   4 gallery/showroom (art, pedestals, furniture)   5 books (shelves of spines)

/** Map a signage word to a shop interior category. */
export function shopCategory(signage: string | undefined, seed: number): number {
  const s = (signage ?? '').toUpperCase();
  if (/CAFE|COFFEE|DINER|BAR\b|PUB|TAVERN|RESTAURANT|BISTRO|KITCHEN|PIZZA|TACO|RAMEN|SUSHI|NOODLE|PHO|CURRY|BURGER|SANDWICH|DELI|BAKERY|CREPE|FALAFEL|TRATTORIA|MEZZE|SEAFOOD|CHICKEN|GYROS|BBQ|THAI|ICE CREAM|TEA|FOOD|CLUB|CHOCOLATE|CANDY|WINE|BREW|GRILL/.test(s)) return 1;
  if (/CLOTH|BOUTIQUE|SHOE|OUTFIT|THREAD|OUTDOOR|THRIFT|LEATHER|SPORT|APPAREL/.test(s)) return 2;
  if (/BANK|COWORK|DENTIST|CLINIC|CHECKS|EXCHANGE|OPTICAL|VET|HOTEL|INSURANCE|REALTY|OFFICE|SALON|BARBER|BEAUTY|TATTOO|MASSAGE|LAUNDRY|CLEANERS|LOCKSMITH|PAWN|PHONES/.test(s)) return 3;
  if (/GALLERY|FURNITURE|HOME|JEWEL|FRAMING|ELECTRONIC|ANTIQUE|FLOWER|GARDEN|PERFUME/.test(s)) return 4;
  if (/BOOK|RECORD|MUSIC/.test(s)) return 5;
  if (s) return 0;
  return [0, 1, 1, 2, 0, 3, 4, 1][seed % 8];
}

export const SHOP_GLSL = /* glsl */ `
vec3 gEmit = vec3(0.0);
vec3 gOutIrr = vec3(1.0);
float gLampOn = 1.0;
float sbox(vec2 q, vec2 c, vec2 h){ vec2 d = abs(q - c) - h; return 1.0 - step(0.0, max(d.x, d.y)); }
float scirc(vec2 q, vec2 c, float r){ return 1.0 - step(r, length(q - c)); }
float wvn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(wh2(i), wh2(i+vec2(1,0)), f.x), mix(wh2(i+vec2(0,1)), wh2(i+vec2(1,1)), f.x), f.y); }
// product colours: saturated-but-muted retail palette (linear)
vec3 hcol(float h){
  return h < 0.12 ? vec3(0.50,0.07,0.05) : h < 0.24 ? vec3(0.06,0.13,0.32) : h < 0.36 ? vec3(0.62,0.46,0.18)
       : h < 0.46 ? vec3(0.07,0.20,0.10) : h < 0.58 ? vec3(0.72,0.68,0.60) : h < 0.68 ? vec3(0.03,0.03,0.035)
       : h < 0.78 ? vec3(0.45,0.20,0.07) : h < 0.88 ? vec3(0.30,0.32,0.35) : vec3(0.60,0.28,0.30);
}
vec3 clothCol(float h){
  return h < 0.18 ? vec3(0.06,0.09,0.17) : h < 0.32 ? vec3(0.025,0.025,0.03) : h < 0.44 ? vec3(0.62,0.58,0.50)
       : h < 0.55 ? vec3(0.20,0.22,0.12) : h < 0.66 ? vec3(0.42,0.14,0.06) : h < 0.76 ? vec3(0.75,0.74,0.72)
       : h < 0.86 ? vec3(0.28,0.30,0.34) : vec3(0.45,0.36,0.24);
}
// Shelving unit (in a plane): frame, boards every sp, goods of varying height/colour with gaps.
vec4 shelfUnit(vec2 q, float x0, float x1, float yTop, float sp, float sd, float books){
  if (q.x < x0 || q.x > x1 || q.y < 0.0 || q.y > yTop) return vec4(0.0);
  vec3 frame = books > 0.5 ? vec3(0.22,0.13,0.07) : vec3(0.36,0.34,0.31);
  if (q.x < x0 + 0.035 || q.x > x1 - 0.035 || q.y > yTop - 0.035) return vec4(frame, 1.0);
  if (q.y < 0.12) return vec4(frame * 0.6, 1.0);
  float row = floor((q.y - 0.12) / sp);
  float fy = q.y - 0.12 - row * sp;
  if (fy < 0.025) return vec4(frame * 1.1, 1.0);
  float slotW = books > 0.5 ? 0.034 : 0.07 + 0.11 * wh1(row * 7.13 + sd);
  float si = floor((q.x - x0) / slotW);
  float fx = fract((q.x - x0) / slotW);
  float h = wh2(vec2(si, row * 13.0 + sd));
  float ih = (books > 0.5 ? 0.62 + 0.3 * h : 0.25 + 0.6 * h) * (sp - 0.03);
  float run = wh2(vec2(floor((q.x - x0) / 0.55), row + sd * 3.0));
  float empty = step(0.8, run) + (books > 0.5 ? 0.0 : step(0.75, fx));
  vec3 back = frame * 0.35;
  if (fy - 0.025 < ih && empty < 0.5) {
    float cph = books > 0.5 ? wh2(vec2(si + 3.1, row * 5.0 + sd)) : wh2(vec2(floor((q.x - x0) / 0.3) + 3.1, row * 5.0 + sd));
    vec3 c = hcol(cph);
    if (books > 0.5) c = mix(c, vec3(0.55,0.5,0.42), 0.25 * step(0.6, h)) * (0.8 + 0.3 * step(0.85, fract((fy - 0.025) / max(ih, 0.01) * 5.0)));
    else c *= 0.8 + 0.35 * step(0.65, (fy - 0.025) / max(ih, 0.01)); // label band / lid
    return vec4(c, 1.0);
  }
  return vec4(back, 1.0);
}
// Hanging garments on a rail (plane coords: u along rail, y up).
vec4 rackGarments(vec2 q, float x0, float x1, float railY, float sd){
  if (q.x < x0 - 0.04 || q.x > x1 + 0.04 || q.y < 0.0 || q.y > railY + 0.08) return vec4(0.0);
  vec3 metal = vec3(0.55,0.55,0.56);
  if (abs(q.y - railY) < 0.012 && q.x > x0 - 0.04 && q.x < x1 + 0.04) return vec4(metal, 1.0);
  if ((abs(q.x - x0 + 0.03) < 0.012 || abs(q.x - x1 - 0.03) < 0.012) && q.y < railY) return vec4(metal * 0.8, 1.0);
  if (q.y < 0.03 && (abs(q.x - x0) < 0.15 || abs(q.x - x1) < 0.15)) return vec4(metal * 0.6, 1.0);
  float gi = floor((q.x - x0) / 0.055);
  float gh = wh2(vec2(gi, sd));
  float len = 0.55 + 0.45 * wh2(vec2(floor(gi / 4.0), sd + 7.0));
  float top = railY - 0.04 - 0.05 * smoothstep(0.0, 0.5, abs(fract((q.x - x0) / 0.055) - 0.5));
  if (q.y < top && q.y > railY - len && q.x > x0 && q.x < x1) {
    vec3 c = clothCol(wh2(vec2(floor(gi / 3.0), sd + 1.0)) * 0.85 + gh * 0.15);
    c *= 0.72 + 0.28 * smoothstep(0.0, 0.45, fract((q.x - x0) / 0.055)); // fold shading
    return vec4(c, 1.0);
  }
  if (q.y > top && q.y < railY && abs(fract((q.x - x0) / 0.055) - 0.5) < 0.1 && q.x > x0 && q.x < x1) return vec4(metal * 0.7, 1.0); // hangers
  return vec4(0.0);
}
vec4 mannequin(vec2 q, float x, float sd){
  vec2 p = q - vec2(x, 0.0);
  vec3 skin = wh1(sd) < 0.5 ? vec3(0.78,0.76,0.72) : vec3(0.05,0.05,0.05);
  vec3 top = clothCol(wh1(sd * 3.7));
  vec3 bot = clothCol(wh1(sd * 5.3));
  if (scirc(p, vec2(0.0, 1.66), 0.1) > 0.5) return vec4(skin, 1.0);
  if (sbox(p, vec2(0.0, 1.52), vec2(0.035, 0.05)) > 0.5) return vec4(skin, 1.0);
  float tw = mix(0.13, 0.2, smoothstep(1.02, 1.46, p.y));
  if (p.y > 1.0 && p.y < 1.48 && abs(p.x) < tw) return vec4(top, 1.0);
  if (p.y > 1.02 && p.y < 1.45 && abs(abs(p.x) - 0.23) < 0.04) return vec4(top * 0.85, 1.0); // arms
  if (wh1(sd * 9.1) < 0.5) { if (p.y > 0.45 && p.y < 1.0 && abs(p.x) < mix(0.26, 0.14, (p.y - 0.45) / 0.55)) return vec4(bot, 1.0); }
  else if (p.y > 0.1 && p.y < 1.0 && abs(abs(p.x) - 0.075) < 0.06) return vec4(bot, 1.0);
  if (abs(p.x) < 0.012 && p.y < 0.6) return vec4(vec3(0.5), 1.0);
  if (abs(p.x) < 0.16 && p.y < 0.025) return vec4(vec3(0.25), 1.0);
  return vec4(0.0);
}
vec4 person(vec2 q, float x, float seated, float sd){
  vec2 p = q - vec2(x, seated > 0.5 ? -0.42 : 0.0);
  vec3 c = clothCol(wh1(sd)) * 0.9;
  if (scirc(p, vec2(0.0, 1.62), 0.1) > 0.5) return vec4(mix(vec3(0.35,0.22,0.15), vec3(0.08,0.06,0.05), step(1.64, p.y + 0.02 * wh1(sd*2.0))), 1.0);
  if (p.y > 1.0 && p.y < 1.5 && abs(p.x) < mix(0.14, 0.2, smoothstep(1.0, 1.42, p.y))) return vec4(c, 1.0);
  if (seated < 0.5 && p.y > 0.05 && p.y < 1.0 && abs(abs(p.x) - 0.07) < 0.06) return vec4(vec3(0.05,0.06,0.09), 1.0);
  return vec4(0.0);
}
// Cafe table + 2 chairs (+ pendant) around centre c.
vec4 cafeTable(vec2 q, float c, float flH, float sd, float withPeople){
  float dx = q.x - c;
  vec3 wood = mix(vec3(0.20,0.11,0.06), vec3(0.42,0.30,0.18), wh1(sd));
  vec3 chair = wh1(sd * 1.3) < 0.5 ? vec3(0.04,0.04,0.045) : vec3(0.28,0.16,0.08);
  // pendant
  if (abs(dx) < 0.006 && q.y > 2.25 && q.y < flH) return vec4(vec3(0.02), 1.0);
  float sw = mix(0.07, 0.2, clamp((2.28 - q.y) / 0.26, 0.0, 1.0));
  if (q.y > 2.02 && q.y < 2.28 && abs(dx) < sw) {
    if (q.y < 2.05) { gEmit += vec3(1.0, 0.72, 0.4) * 5.0 * gLampOn * uLamp; return vec4(vec3(1.0,0.9,0.7), 1.0); }
    return vec4(wh1(sd * 4.1) < 0.5 ? vec3(0.02,0.03,0.025) : vec3(0.5,0.35,0.15), 1.0);
  }
  // people
  if (withPeople > 0.5) {
    float side = wh1(sd * 7.7) < 0.5 ? -1.0 : 1.0;
    vec4 pp = person(q, c + side * 0.6, 1.0, sd * 3.3);
    if (pp.a > 0.5) return pp;
  }
  if (q.y > 0.72 && q.y < 0.765 && abs(dx) < 0.38) return vec4(wood * 1.15, 1.0);
  if (q.y < 0.72 && abs(dx) < 0.022) return vec4(vec3(0.05), 1.0);
  if (q.y < 0.025 && abs(dx) < 0.2) return vec4(vec3(0.05), 1.0);
  for (int k = 0; k < 2; k++) {
    float s = k == 0 ? -1.0 : 1.0;
    float cx = dx - s * 0.55;
    if (q.y > 0.43 && q.y < 0.47 && abs(cx) < 0.2) return vec4(chair, 1.0);
    if (abs(cx - s * 0.18) < 0.018 && q.y < 0.92) return vec4(chair, 1.0);
    if (abs(cx + s * 0.17) < 0.015 && q.y < 0.45) return vec4(chair, 1.0);
    if (q.y > 0.62 && q.y < 0.9 && abs(cx - s * 0.18) < 0.03) return vec4(chair, 1.0);
  }
  return vec4(0.0);
}

// Depth (m behind the glass) of silhouette layer li for a category; < 0 = unused.
float shopLayerZ(float li, float cat, float D){
  if (cat < 0.5 || cat > 4.5) return li < 0.5 ? 0.45 : li < 1.5 ? 2.2 : li < 2.5 ? min(D - 1.2, 4.2) : -1.0;
  if (cat < 1.5) return li < 0.5 ? 1.1 : li < 1.5 ? 2.7 : li < 2.5 ? D - 1.7 : -1.0;
  if (cat < 2.5) return li < 0.5 ? 0.6 : li < 1.5 ? 2.0 : li < 2.5 ? min(D - 1.0, 3.8) : -1.0;
  if (cat < 3.5) return li < 0.5 ? 0.8 : li < 1.5 ? 2.3 : li < 2.5 ? D - 1.6 : -1.0;
  return li < 0.5 ? 0.5 : li < 1.5 ? 2.6 : -1.0;
}

vec4 shopLayer(float li, float cat, vec3 q, float RW, float flH, float sd, float rs, float W, float xg){
  vec2 p = q.xy;
  float x0 = 0.45, x1 = RW - 0.45;
  if (cat < 0.5 || cat > 4.5) {
    float books = cat > 4.5 ? 1.0 : 0.0;
    if (li < 0.5) { // display plinth with a few products, inside the window span only
      if (p.x < xg + 0.1 || p.x > xg + W - 0.1) return vec4(0.0);
      if (p.y < 0.32) return vec4(mix(vec3(0.3,0.2,0.12), vec3(0.75,0.73,0.7), step(0.5, wh1(sd * 2.9))), 1.0);
      float si = floor((p.x - xg) / 0.42);
      float fx = fract((p.x - xg) / 0.42);
      float h = wh2(vec2(si, sd));
      if (h < 0.35) return vec4(0.0);
      float ih = 0.32 + 0.1 + 0.45 * wh2(vec2(si, sd + 2.0));
      float shape = wh2(vec2(si, sd + 5.0));
      float w = shape < 0.4 ? 0.12 : shape < 0.7 ? 0.2 : 0.08;
      float m = step(abs(fx - 0.5) * 0.42, w) * step(p.y, ih);
      if (shape < 0.4) m *= step(abs(fx - 0.5) * 0.42, w * (1.0 - 0.6 * smoothstep(ih - 0.15, ih, p.y))); // vase / bottle neck
      if (m > 0.5) return vec4(hcol(wh2(vec2(si, sd + 9.0))) * 1.1, 1.0);
      if (books > 0.5 && p.y < 0.6 && abs(fx - 0.5) < 0.3) return vec4(hcol(wh2(vec2(floor(p.y / 0.05), si))), 1.0); // book stacks
      return vec4(0.0);
    }
    float cw = 1.9;
    float k = floor((p.x - 0.3) / (cw + 0.9));
    float a = 0.3 + k * (cw + 0.9) + (li > 1.5 ? 0.6 : 0.0);
    return shelfUnit(p, a, a + cw, li < 1.5 ? 1.55 : 1.75, books > 0.5 ? 0.33 : 0.36, sd + li * 17.0 + k, books);
  }
  if (cat < 1.5) {
    if (li < 1.5) {
      float x0t = 0.8 + 0.5 * wh1(sd + li) + li * 0.95;
      float k = floor((p.x - x0t) / 1.9 + 0.5);
      float c = x0t + k * 1.9;
      if (c < 0.6 || c > RW - 0.6) return vec4(0.0);
      float busy = step(wh2(vec2(k, sd + li)), 0.35 + 0.3 * uNight);
      return cafeTable(p, c, flH, wh2(vec2(k + 11.0, sd + li)), busy);
    }
    // counter with espresso machine / pastry case, stools
    if (p.x < 0.7 || p.x > RW - 1.2) return vec4(0.0);
    vec3 cc = wh1(sd * 3.1) < 0.5 ? vec3(0.25,0.13,0.06) : vec3(0.62,0.60,0.56);
    if (p.y < 1.02) {
      if (p.y > 0.98) return vec4(vec3(0.7,0.68,0.64), 1.0);
      return vec4(cc * (0.85 + 0.15 * step(0.5, fract(p.x / 0.6))), 1.0);
    }
    float mx = RW * (0.3 + 0.3 * wh1(sd * 8.3));
    if (sbox(p, vec2(mx, 1.22), vec2(0.3, 0.2)) > 0.5) return vec4(vec3(0.55,0.56,0.58), 1.0);
    if (sbox(p, vec2(mx + 1.3, 1.25), vec2(0.5, 0.22)) > 0.5) { gEmit += vec3(1.0,0.85,0.6) * 0.8 * gLampOn * uLamp; return vec4(vec3(0.85,0.7,0.5), 1.0); }
    if (wh1(sd * 1.9) < 0.6) { vec4 pp = person(vec2(p.x, p.y), mx - 0.8, 0.0, sd * 1.7); if (pp.a > 0.5) return pp; }
    return vec4(0.0);
  }
  if (cat < 2.5) {
    if (li < 0.5) {
      float n = W > 2.5 ? 2.0 : 1.0;
      for (int i = 0; i < 2; i++) {
        if (float(i) >= n) break;
        float mx = xg + W * (n > 1.5 ? (i == 0 ? 0.28 : 0.72) : 0.5) + 0.2 * (wh1(sd + float(i)) - 0.5);
        vec4 m = mannequin(p, mx, sd * 1.9 + float(i) * 3.1);
        if (m.a > 0.5) return m;
      }
      return vec4(0.0);
    }
    float cw = 1.7;
    float k = floor((p.x - 0.4) / (cw + 0.8));
    float a = 0.4 + k * (cw + 0.8) + (li > 1.5 ? 0.9 : 0.0);
    if (a + cw > RW - 0.3) return vec4(0.0);
    return rackGarments(p, a, a + cw, li > 1.5 ? 1.75 : 1.45, sd + li * 13.0 + k);
  }
  if (cat < 3.5) {
    if (li < 0.5) { // potted plant near the glass (sometimes)
      if (wh1(sd * 6.1) > 0.5) return vec4(0.0);
      float px = xg + (wh1(sd * 2.2) < 0.5 ? 0.45 : W - 0.45);
      if (sbox(p, vec2(px, 0.22), vec2(0.17, 0.22)) > 0.5) return vec4(vec3(0.3,0.28,0.26), 1.0);
      float r = wvn(p * 11.0);
      if (length((p - vec2(px, 0.85)) * vec2(1.0, 0.7)) < 0.38 + 0.12 * r) return vec4(vec3(0.05,0.12,0.04) * (0.7 + 0.6 * r), 1.0);
      return vec4(0.0);
    }
    if (li < 1.5) { // workstations: partitions + monitors + chair backs
      float k = floor(p.x / 1.8);
      float c = k * 1.8 + 0.9;
      vec3 pc = mix(vec3(0.34,0.35,0.36), vec3(0.42,0.38,0.32), wh1(sd));
      if (p.y < 1.2 && p.x > 0.3 && p.x < RW - 0.3) {
        if (p.y > 1.16) return vec4(vec3(0.6), 1.0);
        return vec4(pc * (0.9 + 0.1 * step(0.5, fract(p.x / 1.8))), 1.0);
      }
      if (sbox(p, vec2(c, 1.42), vec2(0.26, 0.17)) > 0.5 && wh2(vec2(k, sd)) < 0.8) {
        float on = step(0.3, wh2(vec2(k, sd + 3.0)));
        gEmit += vec3(0.5, 0.65, 0.9) * 0.35 * on * gLampOn;
        return vec4(vec3(0.02), 1.0);
      }
      if (sbox(p, vec2(c, 1.23), vec2(0.03, 0.05)) > 0.5) return vec4(vec3(0.1), 1.0);
      if (wh2(vec2(k, sd + 8.0)) < 0.35) { vec4 pp = person(p, c + 0.5, 1.0, sd + k); if (pp.a > 0.5) return pp; }
      return vec4(0.0);
    }
    // teller / reception counter with glass screen
    if (p.x < 0.6 || p.x > RW - 0.6) return vec4(0.0);
    if (p.y < 1.08) return vec4(p.y > 1.03 ? vec3(0.62,0.6,0.56) : vec3(0.32,0.2,0.12), 1.0);
    return vec4(0.0);
  }
  // gallery / showroom
  if (li < 0.5) {
    if (wh1(sd * 4.4) < 0.5) return vec4(0.0);
    float px = xg + W * (0.3 + 0.4 * wh1(sd * 1.1));
    if (sbox(p, vec2(px, 0.45), vec2(0.28, 0.45)) > 0.5) return vec4(vec3(0.85,0.84,0.82), 1.0);
    if (sbox(p, vec2(px, 0.95), vec2(0.26, 0.05)) > 0.5) { gEmit += vec3(1.0,0.95,0.85) * 0.4 * gLampOn; return vec4(vec3(0.7,0.72,0.72), 1.0); }
    if (scirc(p, vec2(px, 1.1), 0.12) > 0.5) return vec4(hcol(wh1(sd * 7.7)), 1.0);
    return vec4(0.0);
  }
  if (wh1(sd * 9.3) < 0.5) { // sofa / furniture
    float k = floor(p.x / 3.0); float c = k * 3.0 + 1.5;
    vec3 fc = clothCol(wh2(vec2(k, sd)));
    if (abs(p.x - c) < 0.95 && p.y > 0.12 && p.y < 0.45) return vec4(fc, 1.0);
    if (abs(p.x - c) < 0.95 && p.y > 0.45 && p.y < 0.82 && abs(p.x - c) > 0.0) return vec4(fc * 0.8, 1.0);
    if (abs(abs(p.x - c) - 0.95) < 0.1 && p.y < 0.62) return vec4(fc * 0.9, 1.0);
    if (abs(abs(p.x - c) - 0.8) < 0.02 && p.y < 0.12) return vec4(vec3(0.05), 1.0);
    return vec4(0.0);
  }
  float k = floor(p.x / 2.4); float c = k * 2.4 + 1.2;
  if (sbox(p, vec2(c, 0.5), vec2(0.22, 0.5)) > 0.5) return vec4(vec3(0.88,0.87,0.85), 1.0);
  if (sbox(p, vec2(c, 1.2), vec2(0.12, 0.2 * wh2(vec2(k, sd)) + 0.05)) > 0.5) return vec4(hcol(wh2(vec2(k, sd + 1.0))), 1.0);
  return vec4(0.0);
}

// Room surfaces. face: 0 floor, 1 ceiling, 2 side wall (u = depth), 3 back wall (u = x)
vec3 shopSurface(float face, vec3 hp, float cat, float RW, float flH, float D, float sd, float rs){
  vec3 wallC = cat < 0.5 ? vec3(0.62,0.58,0.52) : cat < 1.5 ? (rs < 0.5 ? vec3(0.36,0.16,0.10) : vec3(0.60,0.46,0.32))
             : cat < 2.5 ? vec3(0.80,0.79,0.77) : cat < 3.5 ? vec3(0.62,0.64,0.64) : cat < 4.5 ? vec3(0.86,0.86,0.85) : vec3(0.55,0.45,0.35);
  if (face < 0.5) {
    if (cat > 0.5 && cat < 1.5) {
      if (rs < 0.3) { vec2 g = floor(hp.xz / 0.3); return mix(vec3(0.05), vec3(0.75,0.74,0.7), mod(g.x + g.y, 2.0)); }
      return vec3(0.30,0.18,0.09) * (0.8 + 0.3 * wh1(floor(hp.x / 0.14)));
    }
    if (cat > 2.5 && cat < 3.5) return vec3(0.18,0.2,0.23);
    if (cat > 1.5 && cat < 2.5) return vec3(0.52,0.42,0.30) * (0.85 + 0.2 * wh1(floor(hp.x / 0.18)));
    vec2 g = abs(fract(hp.xz / 0.4) - 0.5);
    return vec3(0.5,0.49,0.46) * (0.92 + 0.08 * step(0.47, max(g.x, g.y)));
  }
  if (face < 1.5) {
    if (cat > 0.5 && cat < 1.5 && rs > 0.5) return vec3(0.06,0.06,0.065);
    vec2 g = abs(fract(hp.xz / 0.6) - 0.5);
    return vec3(0.8) * (0.94 + 0.06 * step(0.46, max(g.x, g.y)));
  }
  float u = face < 2.5 ? hp.z : hp.x;
  vec2 q = vec2(u, hp.y);
  if (cat > 0.5 && cat < 1.5) {
    if (rs < 0.5) { // exposed brick
      float row = floor(hp.y / 0.075);
      vec2 b = vec2(fract((u + mod(row, 2.0) * 0.1) / 0.2), fract(hp.y / 0.075));
      wallC *= 0.85 + 0.3 * wh2(vec2(floor((u + mod(row, 2.0) * 0.1) / 0.2), row));
      if (b.x < 0.05 || b.y < 0.12) wallC = vec3(0.4,0.37,0.33);
    }
    if (face > 2.5) {
      if (hp.y > 1.3 && hp.y < 2.4 && hp.x > 0.8 && hp.x < RW - 0.8) { // back bar
        float sh = fract((hp.y - 1.3) / 0.36);
        if (sh < 0.08) return vec3(0.25,0.15,0.08);
        float bi = floor(hp.x / 0.07);
        float bh = 0.5 + 0.4 * wh2(vec2(bi, floor((hp.y - 1.3) / 0.36)));
        if (sh < 0.08 + bh * 0.85 && fract(hp.x / 0.07) > 0.25) {
          gEmit += vec3(1.0,0.7,0.35) * 0.08 * gLampOn;
          return mix(vec3(0.12,0.2,0.08), vec3(0.45,0.25,0.08), wh2(vec2(bi, 3.0))) * (1.0 + step(sh, 0.08 + bh * 0.3));
        }
        return vec3(0.08,0.06,0.05);
      }
      if (sbox(q, vec2(RW * 0.5, 2.6), vec2(0.8, 0.28)) > 0.5) { // menu board
        float ln = step(0.6, fract(hp.y / 0.07)) * step(0.3, wh2(vec2(floor(hp.y / 0.07), floor(hp.x / 0.3))));
        return mix(vec3(0.03), vec3(0.8), ln * 0.6);
      }
    } else if (hp.y < 1.0 && rs > 0.25) { // booth seating along the side wall
      return hp.y > 0.45 ? vec3(0.28,0.05,0.04) * (0.8 + 0.2 * step(0.5, fract(u / 0.5))) : vec3(0.15,0.08,0.05);
    } else if (sbox(q, vec2(floor(u / 1.6) * 1.6 + 0.8, 1.7), vec2(0.3, 0.22)) > 0.5) return hcol(wh2(vec2(floor(u / 1.6), sd))) * 0.8;
    return wallC;
  }
  if (cat < 0.5 || cat > 4.5) {
    vec4 s = shelfUnit(q, 0.2, face < 2.5 ? D - 0.2 : RW - 0.2, 2.2, cat > 4.5 ? 0.33 : 0.38, sd + face * 31.0, cat > 4.5 ? 1.0 : 0.0);
    return s.a > 0.5 ? s.rgb : wallC;
  }
  if (cat < 2.5) {
    if (face < 2.5) { vec4 g = rackGarments(q, 0.3, D - 0.3, 1.65, sd + 50.0); if (g.a > 0.5) return g.rgb; return wallC; }
    if (hp.y > 0.4 && hp.y < 2.2 && hp.x > 0.5 && hp.x < RW - 0.5) { // cubbies with folded stacks
      vec2 cc = vec2(fract((hp.x - 0.5) / 0.45), fract((hp.y - 0.4) / 0.36));
      if (cc.x < 0.06 || cc.y < 0.08) return vec3(0.9);
      float st = floor((cc.y - 0.08) / 0.12);
      if (cc.y < 0.08 + 0.12 * (1.0 + floor(4.0 * wh2(floor(vec2(hp.x / 0.45, hp.y / 0.36)))))) return clothCol(wh2(vec2(floor(hp.x / 0.45) + st, floor(hp.y / 0.36)))) * (0.85 + 0.15 * step(0.5, fract(cc.y / 0.12 * 1.0)));
      return vec3(0.55);
    }
    return wallC;
  }
  if (cat < 3.5) {
    if (face > 2.5) {
      float dx = RW * (0.2 + 0.6 * wh1(sd * 3.3));
      if (sbox(q, vec2(dx, 1.05), vec2(0.45, 1.05)) > 0.5) return vec3(0.35,0.25,0.16);
      if (sbox(q, vec2(RW - dx, 1.6), vec2(0.5, 0.35)) > 0.5) return mix(vec3(0.05), hcol(wh1(sd)), 0.6);
    }
    return wallC * (hp.y < 1.0 ? 0.85 : 1.0);
  }
  // gallery: framed works
  float k = floor(u / 2.2);
  float c = k * 2.2 + 1.1;
  float fw = 0.35 + 0.35 * wh2(vec2(k, sd)), fh = 0.3 + 0.4 * wh2(vec2(k, sd + 1.0));
  if (sbox(q, vec2(c, 1.6), vec2(fw, fh)) > 0.5) {
    if (sbox(q, vec2(c, 1.6), vec2(fw - 0.04, fh - 0.04)) < 0.5) return vec3(0.04);
    vec2 w = (q - vec2(c, 1.6)) / vec2(fw, fh);
    return mix(hcol(wh2(vec2(k, sd + 2.0))), hcol(wh2(vec2(k, sd + 3.0))), smoothstep(-0.3, 0.3, w.x + 0.4 * sin(w.y * 3.0 + k)));
  }
  return wallC;
}

// Things stuck on / hung directly behind the display glass: posters, hours vinyl, neon, blinds.
// Returns colour (already lit) + coverage.
vec4 shopGlass(vec2 lp, float W, float H, float sill, float sd, float cat, float entry, vec3 lampC){
  vec3 L = gOutIrr * 0.85 + lampC * uLamp * gLampOn * 0.25;
  float fy = lp.y + sill; // height above floor
  // blinds (half down), offices more often
  float hb = wh1(sd * 1.37);
  if (entry < 0.5 && hb < (cat > 2.5 && cat < 3.5 ? 0.55 : 0.18)) {
    float f = 0.25 + 0.4 * wh1(sd * 2.71);
    float yb = H * (1.0 - f);
    if (lp.y > yb) {
      float slat = fract((lp.y - yb) * 16.0);
      vec3 bc = mix(vec3(0.78,0.76,0.72), vec3(0.55,0.5,0.42), step(0.7, wh1(sd * 3.9)));
      return vec4(bc * L * (0.8 + 0.25 * smoothstep(0.1, 0.5, slat)) * (lp.y - yb < 0.04 ? 0.6 : 1.0), 1.0);
    }
  }
  // hours vinyl on the door glass
  if (entry > 0.5) {
    vec2 hq = vec2(lp.x - W * 0.5 - 0.14, fy - 1.3);
    if (hq.x > 0.0 && hq.x < 0.22 && hq.y > 0.0 && hq.y < 0.3) {
      float row = floor(hq.y / 0.035);
      float len = 0.1 + 0.1 * wh2(vec2(row, sd));
      if (fract(hq.y / 0.035) < 0.45 && hq.x < len && row != 7.0) return vec4(vec3(0.85) * L, 1.0);
      if (row > 7.0 && hq.x < 0.2 && fract(hq.y / 0.035) < 0.8) return vec4(vec3(0.85) * L, 1.0);
    }
    return vec4(0.0);
  }
  // posters taped near the bottom corners
  float np = floor(wh1(sd * 4.3) * 3.0);
  for (int i = 0; i < 2; i++) {
    if (float(i) >= np) break;
    float pw = 0.32 + 0.14 * wh1(sd + float(i) * 7.0), ph = pw * 1.4;
    float px = i == 0 ? 0.12 + 0.2 * wh1(sd * 5.0) : W - 0.12 - pw - 0.2 * wh1(sd * 6.0);
    float py = 0.1 + 0.6 * wh1(sd * 8.0 + float(i));
    vec2 pq = vec2(lp.x - px, lp.y - py);
    if (pq.x > 0.0 && pq.x < pw && pq.y > 0.0 && pq.y < ph) {
      vec3 paper = vec3(0.82,0.8,0.74);
      vec2 u = pq / vec2(pw, ph);
      vec3 c = paper;
      if (u.y > 0.38 && u.y < 0.94 && u.x > 0.07 && u.x < 0.93) c = mix(hcol(wh1(sd + float(i) * 3.0)), hcol(wh1(sd + float(i) * 5.0 + 1.0)), smoothstep(0.3, 0.8, u.y + 0.3 * sin(u.x * 5.0 + sd)));
      else if (u.y < 0.32 && u.y > 0.06 && u.x > 0.1 && u.x < 0.9 && fract(u.y / 0.065) < 0.4) c = vec3(0.1);
      return vec4(c * L, 1.0);
    }
  }
  // OPEN neon
  if (cat < 1.5 && wh1(sd * 9.7) < 0.45 && W > 1.2) {
    vec2 nq = vec2(lp.x - (W - 0.75), fy - 1.55);
    if (abs(nq.x) < 0.3 && abs(nq.y) < 0.13) {
      float d = max(abs(nq.x) - 0.28, abs(nq.y) - 0.11);
      float tube = step(abs(d), 0.01);
      float lx = fract((nq.x + 0.24) / 0.12);
      tube = max(tube, step(abs(nq.x), 0.235) * step(abs(nq.y), 0.06) * (step(abs(lx - 0.25), 0.05) + step(abs(lx - 0.75), 0.05) + step(abs(nq.y - 0.055), 0.012)));
      if (tube > 0.5) {
        vec3 nc = wh1(sd * 2.3) < 0.6 ? vec3(1.0, 0.12, 0.08) : vec3(0.15, 0.45, 1.0);
        gEmit += nc * (0.6 + 3.0 * uNight) * gLampOn;
        return vec4(nc * 0.2, 1.0);
      }
    }
  }
  return vec4(0.0);
}

vec3 shadeShop(vec3 d, vec2 lp, float W, float H, float sill, float flH, float seed, float cat, float entry){
  float rs = wh1(seed * 0.71 + 3.0);
  float RW = max(W + 2.6, 6.5);
  float D = 6.0 + 3.0 * wh1(seed * 2.3);
  float xg = (RW - W) * 0.5;
  vec3 p = vec3(lp.x + xg, lp.y + sill, 0.0);
  // lamps: shops are lit through the day; at night most stay lit
  gLampOn = step(wh1(seed * 5.7), mix(0.95, 0.72, step(0.5, uNight)));
  gLampOn = max(gLampOn, 0.12);
  float tx = d.x > 0.0 ? (RW - p.x) / max(d.x, 1e-4) : -p.x / min(d.x, -1e-4);
  float ty = d.y > 0.0 ? (flH - p.y) / max(d.y, 1e-4) : -p.y / min(d.y, -1e-4);
  float tz = D / d.z;
  float t = min(tx, min(ty, tz));
  float face = t == ty ? (d.y < 0.0 ? 0.0 : 1.0) : t == tx ? 2.0 : 3.0;
  vec3 hp = p + d * t;
  gEmit = vec3(0.0);
  vec3 col;
  bool layerHit = false;
  for (int i = 0; i < 3; i++) {
    float z = shopLayerZ(float(i), cat, D);
    if (z <= 0.0) continue;
    float tl = z / d.z;
    if (tl >= t) break;
    vec3 q = p + d * tl;
    if (q.y < 0.0 || q.y > flH || q.x < 0.0 || q.x > RW) continue;
    vec4 L = shopLayer(float(i), cat, q, RW, flH, seed, rs, W, xg);
    if (L.a > 0.5) { col = L.rgb; hp = q; layerHit = true; break; }
  }
  if (!layerHit) col = shopSurface(face, hp, cat, RW, flH, D, seed, rs);
  // lighting: warm fixtures on a 1.8 m grid + daylight falling off with depth
  vec3 lampC = cat > 2.5 && cat < 3.5 ? vec3(0.95, 0.93, 0.88) : mix(vec3(1.0, 0.7, 0.42), vec3(1.0, 0.82, 0.6), rs);
  float depthF = clamp(hp.z / D, 0.0, 1.0);
  vec2 fo = (fract(vec2(hp.x, hp.z) / 1.8) - 0.5) * 1.8;
  float dy = flH - 0.25 - hp.y;
  float pool = 1.0 / (0.55 + 0.9 * (dot(fo, fo) + dy * dy * 0.6));
  vec3 art = lampC * uLamp * gLampOn * (0.25 + pool) * 1.6;
  vec3 day = gDayIrr * (0.3 + 0.9 * (1.0 - depthF) * (1.0 - depthF));
  vec3 rad = col * (day + art) * (1.0 - 0.4 * depthF);
  rad += gEmit;
  gEmit = vec3(0.0);
  vec4 gl = shopGlass(lp, W, H, sill, seed, cat, entry, lampC);
  rad = mix(rad, gl.rgb, gl.a) + gEmit;
  return rad;
}

// Fake "street" reflection: buildings across the street as a band above the horizon (sky/ground from env).
vec4 streetBand(vec3 R, float night){
  float az = atan(R.x, R.z);
  float hz = 0.1 + 0.32 * wvn(vec2(az * 2.6, 3.7)) + 0.08 * step(0.5, wvn(vec2(az * 9.0, 1.3)));
  float cos_ = length(R.xz);
  float el = R.y / max(cos_, 1e-3);
  if (R.y > hz || R.y < -0.015) return vec4(0.0);
  float bi = floor(az * 5.0 + 17.0 * wvn(vec2(az * 0.7, 9.0)));
  float bh = wh1(bi * 3.1);
  vec3 wc = bh < 0.35 ? vec3(0.32,0.13,0.08) : bh < 0.6 ? vec3(0.55,0.5,0.42) : bh < 0.8 ? vec3(0.4,0.4,0.4) : vec3(0.62,0.58,0.5);
  vec2 wg = vec2(az * 38.0, el * 9.0);
  vec2 wf = fract(wg);
  float win = step(0.25, wf.x) * step(wf.x, 0.75) * step(0.3, wf.y) * step(wf.y, 0.85) * step(0.08, el);
  vec3 c = wc * gOutIrr * 0.55;
  vec3 wcol = mix(vec3(0.05,0.06,0.07) * gOutIrr * 4.0, vec3(1.0,0.7,0.4) * 0.6 * step(0.55, wh2(floor(wg))), night);
  c = mix(c, wcol, win);
  c *= 0.75 + 0.25 * smoothstep(0.0, 0.05, el); // darker at street level
  float edge = smoothstep(0.0, 0.015, hz - R.y) * smoothstep(-0.015, 0.0, R.y);
  return vec4(c, edge);
}
`;
