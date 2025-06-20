#!/usr/bin/env python3
"""
Faster-Whisper GPU Server with OpenAI-compatible API
"""
import os
import tempfile
import logging
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.responses import JSONResponse
import uvicorn

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Faster-Whisper Server", version="1.0.0")

# Global model instance
model = None

def initialize_model():
    """Initialize Faster-Whisper model with GPU support"""
    global model
    try:
        from faster_whisper import WhisperModel
        
        model_size = os.getenv("WHISPER_MODEL", "medium")
        device = "cuda"
        compute_type = "float16"
        
        logger.info(f"Loading Faster-Whisper model: {model_size} on {device} with {compute_type}")
        
        model = WhisperModel(
            model_size, 
            device=device, 
            compute_type=compute_type,
            download_root="/app/models"
        )
        
        logger.info("✅ Faster-Whisper model loaded successfully")
        return True
        
    except Exception as e:
        logger.error(f"❌ Failed to load model: {e}")
        return False

@app.on_event("startup")
async def startup_event():
    """Install dependencies and initialize model on startup"""
    import subprocess
    import sys
    
    logger.info("Installing Faster-Whisper dependencies...")
    
    # Install required packages
    packages = [
        "faster-whisper",
        "torch",
        "torchaudio", 
        "python-multipart"
    ]
    
    for package in packages:
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", package])
            logger.info(f"✅ Installed {package}")
        except subprocess.CalledProcessError as e:
            logger.error(f"❌ Failed to install {package}: {e}")
    
    # Initialize model
    if not initialize_model():
        logger.error("Failed to initialize model")

@app.get("/")
async def root():
    return {"message": "Faster-Whisper Server", "status": "running"}

@app.get("/health")
async def health_check():
    global model
    return {
        "status": "healthy" if model is not None else "model_not_loaded",
        "model_loaded": model is not None
    }

@app.post("/v1/audio/transcriptions")
async def transcribe_audio(
    file: UploadFile = File(...),
    model_name: str = Form(alias="model", default="medium"),
    language: Optional[str] = Form(default="ja"),
    response_format: str = Form(default="json"),
    temperature: float = Form(default=0.0)
):
    """OpenAI-compatible transcription endpoint"""
    global model
    
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    
    if not file.filename.lower().endswith(('.wav', '.mp3', '.m4a', '.flac', '.ogg')):
        raise HTTPException(status_code=400, detail="Unsupported audio format")
    
    try:
        # Save uploaded file temporarily
        with tempfile.NamedTemporaryFile(delete=False, suffix=Path(file.filename).suffix) as tmp_file:
            content = await file.read()
            tmp_file.write(content)
            tmp_file_path = tmp_file.name
        
        logger.info(f"🎧 Transcribing {file.filename} ({len(content)} bytes) in {language}")
        
        # Transcribe with Faster-Whisper
        segments, info = model.transcribe(
            tmp_file_path,
            language=language,
            temperature=temperature,
            beam_size=5,
            best_of=5,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500)
        )
        
        # Process segments
        transcription_segments = []
        full_text = ""
        
        for segment in segments:
            segment_data = {
                "id": segment.id,
                "start": segment.start,
                "end": segment.end,
                "text": segment.text
            }
            transcription_segments.append(segment_data)
            full_text += segment.text
        
        # Cleanup temp file
        os.unlink(tmp_file_path)
        
        # Return OpenAI-compatible response
        response = {
            "task": "transcribe",
            "language": info.language,
            "duration": info.duration,
            "text": full_text.strip(),
            "segments": transcription_segments
        }
        
        logger.info(f"✅ Transcription completed: '{full_text.strip()[:50]}...'")
        return response
        
    except Exception as e:
        logger.error(f"❌ Transcription failed: {e}")
        # Cleanup temp file if it exists
        if 'tmp_file_path' in locals():
            try:
                os.unlink(tmp_file_path)
            except:
                pass
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")

@app.get("/v1/models")
async def list_models():
    """List available models"""
    return {
        "object": "list",
        "models": [
            {
                "id": "medium",
                "object": "model",
                "created": 1677610602,
                "owned_by": "openai"
            }
        ]
    }

if __name__ == "__main__":
    uvicorn.run(
        app, 
        host="0.0.0.0", 
        port=8000,
        log_level="info"
    )