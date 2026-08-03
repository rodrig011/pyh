import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPhotoConfig } from '../src/config.js';

/** Runs `fn` with the given env vars set, restoring whatever was there before. */
function withEnv(vars, fn) {
  const previous = {};
  for (const [name, value] of Object.entries(vars)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('a photo may carry a caption unless the deployment says otherwise', () => {
  withEnv({ PHOTO_BOT_TOKEN: 'token', PHOTO_ONLY_ALLOW_CAPTIONS: undefined }, () => {
    assert.equal(loadPhotoConfig().allowCaptions, true);
  });
});

test('captions can still be banned outright', () => {
  withEnv({ PHOTO_BOT_TOKEN: 'token', PHOTO_ONLY_ALLOW_CAPTIONS: 'false' }, () => {
    assert.equal(loadPhotoConfig().allowCaptions, false);
  });
});

test('videos and image links stay opt-in', () => {
  withEnv(
    {
      PHOTO_BOT_TOKEN: 'token',
      PHOTO_ONLY_ALLOW_VIDEOS: undefined,
      PHOTO_ONLY_ALLOW_LINKS: undefined,
    },
    () => {
      const config = loadPhotoConfig();
      assert.equal(config.allowVideos, false);
      assert.equal(config.allowLinks, false);
    },
  );
});
