import { expect, it } from 'vitest';
import { selectProvider, voiceProfiles } from '../src/voice-config';
it('supports only the requested voice providers', () => {
  expect(selectProvider(undefined)).toBe('openai');
  expect(selectProvider('elevenlabs')).toBe('elevenlabs');
  expect(() => selectProvider('other')).toThrow('invalid_provider');
  expect(voiceProfiles.openai.model).toBe('gpt-live-1');
  expect(voiceProfiles.elevenlabs.model).toBe('eleven_realtime_v1_max');
});
