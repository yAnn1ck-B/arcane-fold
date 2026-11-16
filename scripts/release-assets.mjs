function validateCoordinates(repository, tag) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Expected an owner/repository release location.');
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Use an exact vX.Y.Z release tag.');
}

export function canonicalAssetUrl(repository, tag, name) {
  validateCoordinates(repository, tag);
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new Error('A release asset name cannot contain path separators.');
  return `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(name)}`;
}

export function findDraftRelease(repository, tag, runGithub) {
  validateCoordinates(repository, tag);
  let release;
  try {
    release = JSON.parse(runGithub(['api', `repos/${repository}/releases/tags/${tag}`]));
  } catch (error) {
    if (!/\bHTTP 404\b/.test(error?.message ?? '')) throw error;
    const releases = JSON.parse(runGithub(['api', `repos/${repository}/releases?per_page=100`]));
    release = releases.find(item => item.tag_name === tag && item.draft);
  }
  if (!release) throw new Error('The tagged draft release was not found.');
  if (!release.draft) throw new Error('Published releases are immutable. Create a higher version instead.');
  return release;
}
