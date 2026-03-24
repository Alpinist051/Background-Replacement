# Known Limitations (Dev Step)

This repository currently renders:
- `none` effect: real-time copy to the processed canvas
- `blur` and `image` effects: UI-only controls (no AI/background effect yet)

Once AI processing is enabled, limitations will include:

## Model and mask quality

Hair/glasses preservation depends on:
- the quality of the segmentation mask
- how aggressively you feather/erode mask edges
- how you blend foreground/background (avoid hard thresholds that cause halos)

If users report haloing:
- reduce mask edge thresholding
- increase feathering width slightly
- avoid over-blurring edges of the person mask

## Lighting robustness

Under poor lighting, segmentation confidence can drop.
Mitigations:
- apply slight luminance normalization before segmentation (done in worker)
- clamp/scale blur based on confidence (when confidence masks are enabled)

## Performance variance

Segmentation models can have variable runtime across devices.
Production mitigations:
- cap internal processing resolution
- throttle segmentation
- reuse the latest mask for intermediate render frames

