// Add this type declaration at the top level
type FileSystem = {
  writeFileSync: (path: string, data: any) => void;
  readFileSync: (
    path: string,
    options?: { encoding?: string | null; flag?: string } | string
  ) => string;
};

// Declare fs variable safely
declare const require: any;
export const getFs = (): FileSystem => {
  if (typeof window !== "undefined") {
    throw new Error(
      "File system operations are not supported in browser environments"
    );
  }

  try {
    return require("fs");
  } catch (error) {
    throw new Error("Failed to load file system module");
  }
};
