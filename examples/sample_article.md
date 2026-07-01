# Stable Example Method for Medical Image Watermarking

## Abstract

This paper proposes Stable Example Method, a watermarking framework for medical images. The method embeds a robust message into radiology images and preserves diagnostic visual quality. Experiments on BrainMRI and Montgomery X-ray show improved bit accuracy under Gaussian noise and JPEG compression.

## Method

Stable Example Method contains a tri-domain encoder, a blind decoder, and an evidence-aware loss. The tri-domain encoder combines spatial residual embedding, frequency residual embedding, and feature-conditioned embedding. The blind decoder recovers a 32-bit message from the watermarked image.

## Experiments

We evaluate the method on BrainMRI and Montgomery datasets. Baselines include HiDDeN and StegaStamp. Metrics include bit accuracy, PSNR, and SSIM. The attack protocol contains Gaussian noise, JPEG compression, and center crop.

## Results

Stable Example Method achieves 91.2% bit accuracy on BrainMRI and 89.7% bit accuracy on Montgomery after JPEG compression. The average PSNR is 37.5 dB and the average SSIM is 0.96.

## Conclusion

The results suggest that evidence-aware watermarking can improve robustness while preserving medical image quality.
