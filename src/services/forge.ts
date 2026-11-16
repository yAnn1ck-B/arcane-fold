import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { ExportResult, ForgePaths, IntegrationReport } from '@/lib/types';

export function detectForgePaths() {
  return invoke<ForgePaths>('detect_forge_paths');
}

export function testForgeIntegration(paths: ForgePaths) {
  return invoke<IntegrationReport>('test_forge_integration', { paths });
}

export function readCachedImage(path: string, imageCacheDir: string) {
  return invoke<string>('read_cached_image', { path, imageCacheDir });
}

export function exportTestDeck(deckDir: string, name: string) {
  return invoke<ExportResult>('export_test_deck', { deckDir, name });
}

export async function chooseDirectory(defaultPath: string) {
  const selected = await open({ directory: true, multiple: false, defaultPath: defaultPath || undefined, title: 'Select Forge folder' });
  return typeof selected === 'string' ? selected : null;
}
