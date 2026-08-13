import { Env, getConfig } from '../env';

export class AudioAPI {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  readonly transcriptionModel: string;
  readonly ttsModel: string;
  readonly ttsVoice: string;

  constructor(env: Env) {
    const config = getConfig(env);
    this.apiKey = config.audioApiKey;
    this.baseUrl = config.audioApiBaseUrl;
    this.transcriptionModel = config.transcriptionModel;
    this.ttsModel = config.ttsModel;
    this.ttsVoice = config.ttsVoice;
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async transcribe(audio: Blob, filename = 'voice.ogg', signal?: AbortSignal): Promise<string> {
    this.requireKey();
    const body = new FormData();
    body.append('file', audio, filename);
    body.append('model', this.transcriptionModel);
    body.append('response_format', 'json');
    const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}` }, body, signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Transcription API error ${response.status}: ${text.slice(0, 300)}`);
    try {
      const data = JSON.parse(text) as { text?: string };
      if (!data.text?.trim()) throw new Error('Transcription response contained no text.');
      return data.text.trim();
    } catch (error) {
      if (error instanceof Error && error.message.includes('contained no text')) throw error;
      throw new Error('Transcription API returned invalid JSON.');
    }
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<Uint8Array> {
    this.requireKey();
    const input = text.trim();
    if (!input) throw new Error('Provide text to speak.');
    if (input.length > 1_000) throw new Error('Speech text is limited to 1,000 characters.');
    const response = await fetch(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.ttsModel, voice: this.ttsVoice, input, response_format: 'mp3' }),
      signal,
    });
    if (!response.ok) throw new Error(`Speech API error ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > 10 * 1024 * 1024) throw new Error('Generated speech exceeds the 10 MB limit.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('Generated speech exceeds the 10 MB limit.');
    return bytes;
  }

  private requireKey(): void {
    if (!this.apiKey) throw new Error('AUDIO_API_KEY is not configured.');
  }
}
