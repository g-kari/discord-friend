#!/bin/bash

# Discord Go Bot Development Server with Air
echo "🚀 Starting Discord Go Bot development server..."

# Check if Air is installed
if ! command -v air &> /dev/null; then
    echo "❌ Air not found. Installing Air for live reload..."
    go install github.com/cosmtrek/air@latest
fi

# Ensure logs directory exists
mkdir -p logs

# Start development server with Air
echo "🔄 Starting development server with hot reload..."
echo "📁 Working directory: $(pwd)"
echo "📋 Air config: .air.toml"
echo "📝 Logs: logs/build-errors.log"
echo ""
echo "🎤 Bot will auto-restart on code changes"
echo "🛑 Press Ctrl+C to stop"
echo ""

air -c .air.toml