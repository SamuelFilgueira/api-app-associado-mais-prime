export interface ValidateAppVersionResponseDto {
  forceUpdate: boolean;
  title: string;
  message: string;
  storeUrl?: string;
  minSupportedVersion: string;
  minSupportedRuntimeVersion: string;
}
