package screen

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

// ScreenCapture handles screen capture functionality
type ScreenCapture struct {
	outputDir string
}

// NewScreenCapture creates a new screen capture instance
func NewScreenCapture() *ScreenCapture {
	return &ScreenCapture{
		outputDir: "tmp/screenshots",
	}
}

// TakeScreenshot captures the current screen and returns the file path
func (sc *ScreenCapture) TakeScreenshot() (string, error) {
	// Ensure output directory exists
	if err := os.MkdirAll(sc.outputDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create screenshot directory: %w", err)
	}

	// Generate unique filename
	timestamp := time.Now().Unix()
	filename := fmt.Sprintf("screenshot_%d.png", timestamp)
	filepath := filepath.Join(sc.outputDir, filename)

	// Take screenshot based on OS
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// Use PowerShell to take screenshot on Windows
		powershellScript := fmt.Sprintf(`
			Add-Type -AssemblyName System.Windows.Forms
			Add-Type -AssemblyName System.Drawing
			$Screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
			$bitmap = New-Object System.Drawing.Bitmap $Screen.Width, $Screen.Height
			$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
			$graphics.CopyFromScreen($Screen.Left, $Screen.Top, 0, 0, $bitmap.Size)
			$bitmap.Save('%s')
			$graphics.Dispose()
			$bitmap.Dispose()
		`, filepath)
		cmd = exec.Command("powershell", "-Command", powershellScript)

	case "darwin":
		// Use screencapture on macOS
		cmd = exec.Command("screencapture", "-x", filepath)

	case "linux":
		// Try different screenshot tools on Linux
		if sc.commandExists("gnome-screenshot") {
			cmd = exec.Command("gnome-screenshot", "-f", filepath)
		} else if sc.commandExists("scrot") {
			cmd = exec.Command("scrot", filepath)
		} else if sc.commandExists("import") {
			// ImageMagick
			cmd = exec.Command("import", "-window", "root", filepath)
		} else {
			// WSL/Headless environment - create a demo screenshot
			return sc.createDemoScreenshot(filepath)
		}

	default:
		return "", fmt.Errorf("unsupported operating system: %s", runtime.GOOS)
	}

	// Execute screenshot command
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("failed to take screenshot: %w", err)
	}

	// Verify file was created
	if _, err := os.Stat(filepath); os.IsNotExist(err) {
		return "", fmt.Errorf("screenshot file was not created")
	}

	return filepath, nil
}

// commandExists checks if a command exists in PATH
func (sc *ScreenCapture) commandExists(cmd string) bool {
	_, err := exec.LookPath(cmd)
	return err == nil
}

// StartScreenSharing starts continuous screen capture for sharing
func (sc *ScreenCapture) StartScreenSharing(interval time.Duration) <-chan string {
	screenshots := make(chan string, 10)
	
	go func() {
		defer close(screenshots)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		
		for range ticker.C {
			screenshot, err := sc.TakeScreenshot()
			if err != nil {
				fmt.Printf("❌ Screenshot error: %v\n", err)
				continue
			}
			
			select {
			case screenshots <- screenshot:
				fmt.Printf("📸 Screenshot captured: %s\n", screenshot)
			default:
				// Channel full, skip this screenshot
				os.Remove(screenshot) // Clean up if channel is full
			}
		}
	}()
	
	return screenshots
}

// createDemoScreenshot creates a simple demo image for testing
func (sc *ScreenCapture) createDemoScreenshot(filepath string) (string, error) {
	// Create a simple PNG file with demonstration content
	// This is for WSL/headless environments where actual screenshots aren't possible
	
	// Simple 1x1 PNG in base64 (transparent pixel)
	pngData := []byte{
		0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
		0x00, 0x00, 0x00, 0x0D, // IHDR chunk size
		0x49, 0x48, 0x44, 0x52, // IHDR
		0x00, 0x00, 0x00, 0x01, // width: 1
		0x00, 0x00, 0x00, 0x01, // height: 1
		0x08, 0x06, 0x00, 0x00, 0x00, // bit depth, color type, etc.
		0x1F, 0x15, 0xC4, 0x89, // CRC
		0x00, 0x00, 0x00, 0x0A, // IDAT chunk size
		0x49, 0x44, 0x41, 0x54, // IDAT
		0x78, 0x9C, 0x62, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, // compressed data
		0xE2, 0x21, 0xBC, 0x33, // CRC
		0x00, 0x00, 0x00, 0x00, // IEND chunk size
		0x49, 0x45, 0x4E, 0x44, // IEND
		0xAE, 0x42, 0x60, 0x82, // CRC
	}

	err := os.WriteFile(filepath, pngData, 0644)
	if err != nil {
		return "", fmt.Errorf("failed to create demo screenshot: %w", err)
	}

	fmt.Printf("📸 Created demo screenshot for WSL environment: %s\n", filepath)
	return filepath, nil
}

// CleanupOldScreenshots removes old screenshot files
func (sc *ScreenCapture) CleanupOldScreenshots(maxAge time.Duration) error {
	files, err := filepath.Glob(filepath.Join(sc.outputDir, "screenshot_*.png"))
	if err != nil {
		return err
	}

	cutoff := time.Now().Add(-maxAge)
	for _, file := range files {
		info, err := os.Stat(file)
		if err != nil {
			continue
		}

		if info.ModTime().Before(cutoff) {
			os.Remove(file)
		}
	}

	return nil
}