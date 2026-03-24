#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_foreground;
uniform sampler2D u_blurTex;
uniform sampler2D u_maskTex;

uniform vec2 u_maskInvSize;
uniform vec2 u_smallInvSize;
uniform float u_blurStrengthNorm;
uniform float u_flipY;

float computeMaskAlpha(vec2 uv) {
  // Dilate via max-of-neighbors to preserve hair/accessories without holes.
  float c = texture(u_maskTex, uv).r;
  float l = texture(u_maskTex, uv + vec2(-u_maskInvSize.x, 0.0)).r;
  float r = texture(u_maskTex, uv + vec2(u_maskInvSize.x, 0.0)).r;
  float u = texture(u_maskTex, uv + vec2(0.0, -u_maskInvSize.y)).r;
  float d = texture(u_maskTex, uv + vec2(0.0, u_maskInvSize.y)).r;
  float a = max(c, max(l, max(r, max(u, d))));

  // Feather edge to reduce halos.
  return smoothstep(0.12, 0.85, a);
}

vec4 blurBackground(vec2 uv) {
  float radius = u_blurStrengthNorm * 6.0 + 0.5;
  vec2 offX = vec2(u_smallInvSize.x * radius, 0.0);
  vec2 offY = vec2(0.0, u_smallInvSize.y * radius);

  vec4 c = texture(u_blurTex, uv);
  vec4 b = texture(u_blurTex, uv + offX) + texture(u_blurTex, uv - offX)
         + texture(u_blurTex, uv + offY) + texture(u_blurTex, uv - offY);
  return (c + b) / 5.0;
}

void main() {
  vec2 uv = v_uv;
  if (u_flipY > 0.5) {
    uv.y = 1.0 - uv.y;
  }

  float alpha = computeMaskAlpha(uv);

  vec4 fg = texture(u_foreground, uv);
  vec4 bg = blurBackground(uv);
  outColor = mix(bg, fg, alpha);
}

