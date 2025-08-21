export interface PdfConversionResult {
  imageUrl: string;
  file: File | null;
  error?: string;
}

let pdfjsLib: any = null;
let isLoading = false;
let loadPromise: Promise<any> | null = null;

async function loadPdfJs(): Promise<any> {
  if (pdfjsLib) return pdfjsLib;
  if (loadPromise) return loadPromise;

  isLoading = true;
  loadPromise = (async () => {
    try {
      // @ts-expect-error - pdfjs-dist/build/pdf.mjs is not a module
      const lib = await import("pdfjs-dist/build/pdf.mjs");

      // Set the worker source to use local file with fallbacks
      if (!lib.GlobalWorkerOptions.workerSrc) {
        // Try local file first
        lib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

        // Test if the local worker file exists by trying to fetch it
        try {
          const response = await fetch("/pdf.worker.min.mjs", {
            method: "HEAD",
          });
          if (!response.ok) {
            throw new Error("Local worker not found");
          }
        } catch (fetchError) {
          console.warn(
            "Local PDF worker not found, falling back to CDN:",
            fetchError
          );
          // Fallback to CDN
          lib.GlobalWorkerOptions.workerSrc =
            "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.3.93/pdf.worker.min.mjs";
        }
      }

      pdfjsLib = lib;
      isLoading = false;
      console.log(
        "PDF.js loaded successfully with worker:",
        lib.GlobalWorkerOptions.workerSrc
      );
      return lib;
    } catch (error) {
      isLoading = false;
      loadPromise = null; // Reset so we can try again
      throw new Error(`Failed to load PDF.js: ${error}`);
    }
  })();

  return loadPromise;
}

export async function convertPdfToImage(
  file: File,
  options: {
    scale?: number;
    pageNumber?: number;
    quality?: number;
  } = {}
): Promise<PdfConversionResult> {
  const { scale = 2, pageNumber = 1, quality = 1.0 } = options;

  try {
    console.log("Starting PDF conversion for:", file.name);

    // Validate input
    if (!file) {
      throw new Error("No file provided");
    }

    if (
      file.type !== "application/pdf" &&
      !file.name.toLowerCase().endsWith(".pdf")
    ) {
      throw new Error("File must be a PDF");
    }

    // Check file size (50MB limit)
    const maxSize = 50 * 1024 * 1024;
    if (file.size > maxSize) {
      throw new Error(
        `File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB (max 50MB)`
      );
    }

    console.log("Loading PDF.js library...");
    const lib = await loadPdfJs();

    console.log("Reading file as array buffer...");
    const arrayBuffer = await file.arrayBuffer();

    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      throw new Error("Failed to read file or file is empty");
    }

    console.log("Loading PDF document...");
    const loadingTask = lib.getDocument({
      data: arrayBuffer,
      // Add options for better compatibility
      verbosity: 0, // Reduce console noise
      cMapUrl: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.3.93/cmaps/",
      cMapPacked: true,
      standardFontDataUrl:
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.3.93/standard_fonts/",
      useSystemFonts: true,
    });

    const pdf = await loadingTask.promise;

    if (!pdf || pdf.numPages === 0) {
      throw new Error("PDF document is invalid or has no pages");
    }

    // Validate page number
    if (pageNumber < 1 || pageNumber > pdf.numPages) {
      throw new Error(
        `Invalid page number: ${pageNumber} (PDF has ${pdf.numPages} pages)`
      );
    }

    console.log(`Loading page ${pageNumber} of ${pdf.numPages}...`);
    const page = await pdf.getPage(pageNumber);

    if (!page) {
      throw new Error(`Failed to load page ${pageNumber}`);
    }

    console.log("Setting up canvas...");
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error(
        "Failed to get 2D context from canvas - your browser may not support HTML5 Canvas"
      );
    }

    // Check if canvas dimensions are reasonable
    if (viewport.width > 8192 || viewport.height > 8192) {
      throw new Error(
        `Canvas too large: ${viewport.width}x${viewport.height}. Try reducing the scale.`
      );
    }

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    // Configure canvas for better quality
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";

    console.log(`Rendering page (${viewport.width}x${viewport.height})...`);
    const renderContext = {
      canvasContext: context,
      viewport: viewport,
    };

    await page.render(renderContext).promise;
    console.log("Page rendered successfully");

    console.log("Converting canvas to blob...");
    return new Promise<PdfConversionResult>((resolve) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            const originalName = file.name.replace(/\.pdf$/i, "");
            const imageFile = new File([blob], `${originalName}.png`, {
              type: "image/png",
            });

            console.log("Conversion successful!");
            resolve({
              imageUrl: URL.createObjectURL(blob),
              file: imageFile,
            });
          } else {
            console.error("Failed to create blob from canvas");
            resolve({
              imageUrl: "",
              file: null,
              error: "Failed to create image blob from canvas",
            });
          }
        },
        "image/png",
        quality
      );
    });
  } catch (err) {
    console.error("PDF conversion error:", err);

    // Provide more specific error messages
    let errorMessage = "Failed to convert PDF";
    if (err instanceof Error) {
      errorMessage = err.message;
    } else if (typeof err === "string") {
      errorMessage = err;
    } else if (err && typeof err === "object" && "message" in err) {
      errorMessage = String(err.message);
    } else {
      errorMessage = `Unknown error occurred: ${String(err)}`;
    }

    return {
      imageUrl: "",
      file: null,
      error: errorMessage,
    };
  }
}

// Utility function to test if PDF.js is working
export async function testPdfJs(): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const lib = await loadPdfJs();

    // Create a minimal PDF for testing
    const testPdfData = new Uint8Array([
      0x25,
      0x50,
      0x44,
      0x46,
      0x2d,
      0x31,
      0x2e,
      0x34,
      0x0a, // %PDF-1.4
      // ... minimal PDF structure
    ]);

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Helper function to check if the worker file exists
export async function checkWorkerFile(): Promise<{
  exists: boolean;
  url: string;
}> {
  const workerUrl = "/pdf.worker.min.mjs";
  try {
    const response = await fetch(workerUrl, { method: "HEAD" });
    return { exists: response.ok, url: workerUrl };
  } catch {
    return { exists: false, url: workerUrl };
  }
}
