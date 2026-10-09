import { BrowserWindow, desktopCapturer, systemPreferences } from 'electron';
import { PracticeCaptureLimits } from '#contracts/PracticeCapture.js';
import { PracticeLimits } from '#contracts/PracticeCheck.js';
import type { PracticeWindowCapturePort } from './PracticeCaptureController.js';

/** Electron window snapshots stay local until explicit review; display-wide capture is excluded. */
export class ElectronPracticeWindowCapture implements PracticeWindowCapturePort {
  private canCapture(): boolean {
    return (
      process.platform !== 'darwin' ||
      ['granted', 'not-determined'].includes(systemPreferences.getMediaAccessStatus('screen'))
    );
  }
  private isOwnWindow(id: string): boolean {
    return BrowserWindow.getAllWindows().some((window) => window.getMediaSourceId() === id);
  }
  async listWindows(): Promise<{ id: string; name: string }[]> {
    if (!this.canCapture()) {
      throw new Error('Screen capture permission required.');
    }
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    return sources
      .filter((source) => !this.isOwnWindow(source.id))
      .map((source) => ({ id: source.id, name: source.name }));
  }
  async captureWindow(id: string): Promise<{ base64: string; width: number; height: number }> {
    if (!this.canCapture() || this.isOwnWindow(id)) {
      throw new Error('Window capture unavailable.');
    }
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: PracticeCaptureLimits.WIDTH, height: PracticeCaptureLimits.HEIGHT },
      fetchWindowIcons: false,
    });
    const source = sources.find((item) => item.id === id);
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error('Window unavailable.');
    }
    const image = source.thumbnail;
    const bytes = image.toJPEG(85);
    if (bytes.length > PracticeLimits.IMAGE_BYTES) {
      throw new Error('Capture too large. Choose a smaller window.');
    }
    return { base64: bytes.toString('base64'), ...image.getSize() };
  }
}
