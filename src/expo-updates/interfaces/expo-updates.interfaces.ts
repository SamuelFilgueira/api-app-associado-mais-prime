export type PlataformaExpo = 'android' | 'ios';

export const PLATAFORMAS_EXPO: readonly PlataformaExpo[] = ['android', 'ios'];

/** Conteúdo de `metadata.json` gerado por `npx expo export`. */
export interface MetadataExport {
  version: number;
  bundler: string;
  fileMetadata: Partial<
    Record<
      PlataformaExpo,
      {
        bundle: string;
        assets: Array<{ path: string; ext: string }>;
      }
    >
  >;
}

/** `release.json` gravado na publicação (metadados próprios, não do Expo). */
export interface ReleaseMeta {
  runtimeVersion: string;
  nome: string;
  criadoEm: string;
  plataformas: PlataformaExpo[];
  descricao?: string;
  origem?: string;
  tamanhoBytes?: number;
}

export interface ReleaseInfo extends ReleaseMeta {
  caminho: string;
  ativa: boolean;
}

export interface AssetManifest {
  hash: string;
  key: string;
  fileExtension: string;
  contentType: string;
  url: string;
}

/** Manifest no formato do Expo Updates Protocol (v0 e v1). */
export interface ManifestExpo {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  launchAsset: AssetManifest;
  assets: AssetManifest[];
  metadata: Record<string, string>;
  extra: { expoClient?: Record<string, unknown> };
}

export interface RequisicaoManifest {
  protocolVersion: 0 | 1;
  platform: string | undefined;
  runtimeVersion: string | undefined;
  currentUpdateId: string | undefined;
  expectSignature: boolean;
  urlBase: string;
}

export interface RespostaManifest {
  status: number;
  headers: Record<string, string>;
  corpo?: Buffer | string;
}
