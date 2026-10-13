export type PackageErrorCode =
  | "INVALID_PACKAGE"
  | "PACKAGE_CONFLICT"
  | "PACKAGE_DENIED"
  | "PACKAGE_QUOTA"
  | "PACKAGE_RECOVERY_REQUIRED"
  | "PACKAGE_EXPIRED";
export class PackageManagementError extends Error {
  constructor(
    readonly code: PackageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PackageManagementError";
  }
}
