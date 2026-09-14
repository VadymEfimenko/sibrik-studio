import type { AssetInput, AssetPreparation, AssetProvider, AssetStatus } from './types.js';

export class MockAssets implements AssetProvider {
  readonly scope = 'mock';
  readonly requiresPublicMedia = false;
  localUrl(id: string) {
    return `asset://mock_${id}`;
  }
  async prepare(input: AssetInput): Promise<AssetPreparation> {
    return { status: 'ready', url: this.localUrl(input.id) };
  }
  async poll(id: string): Promise<AssetStatus> {
    return { status: 'ready', url: this.localUrl(id) };
  }
}
