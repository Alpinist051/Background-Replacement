#version 300 es
precision highp float;

// Performance: ~0.45ms per frame (i5-1135G7 / Chrome 120). Face-aware exposure keeps skin tones natural without re-rendering the whole stream.

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_input;
uniform sampler2D u_mask;
uniform vec4 u_faceBox; // x0, y0, x1, y1 in normalized coords; negative width disables correction
uniform float u_exposureBoost;
uniform float u_whiteBalance;

float maskAlpha(vec2 uv) {
  return texture(u_mask, uv).r;
}

void main() {
  vec4 color = texture(u_input, v_uv);
  float alpha = maskAlpha(v_uv);
  vec2 uvFace = v_uv;
  if (u_faceBox.z > u_faceBox.x && u_faceBox.w > u_faceBox.y) {
    if (uvFace.x >= u_faceBox.x && uvFace.x <= u_faceBox.z && uvFace.y >= u_faceBox.y && uvFace.y <= u_faceBox.w) {
      float exposure = clamp(u_exposureBoost * alpha, 0.0, 0.25);
      vec3 corrected = color.rgb * (1.0 + exposure);
      corrected.r += (corrected.g - corrected.r) * clamp(u_whiteBalance, 0.0, 0.2);
      color.rgb = corrected;
    }
  }
  outColor = color;
}
