// Secrets augment generated Wrangler bindings; no secret values belong here.
interface Env {
  ROBOT_API_TOKEN?: string;
  OPENAI_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  ELEVENLABS_MODEL_ID?: string;
  ALLOWED_ORIGIN?: string;
  // Not a secret: the owner's first name for the robot's greeting (wrangler.jsonc vars).
  OWNER_NAME?: string;
  // Not a secret: "true" lets Robottino say swear words when asked (wrangler.jsonc vars).
  ALLOW_SWEARING?: string;
}
