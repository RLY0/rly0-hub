export const GOOD_KEY: string;
export const MODELS: string[];
export function startFakeRelay(): Promise<{
  baseUrl: string;
  requests: { method?: string; path: string; auth: boolean }[];
  close(): Promise<void>;
}>;
