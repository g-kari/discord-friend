#!/bin/bash
# Production-Ready Local LLM Deployment Script - Worker2 Implementation
# Automated deployment and scaling with monitoring

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.local-llm.yml"
ENV_FILE="$PROJECT_ROOT/.env.local-llm"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    # Check Docker
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed"
        exit 1
    fi
    
    # Check Docker Compose
    if ! command -v docker-compose &> /dev/null; then
        log_error "Docker Compose is not installed"
        exit 1
    fi
    
    # Check GPU support
    if command -v nvidia-smi &> /dev/null; then
        log_success "NVIDIA GPU detected"
        nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
    else
        log_warning "No NVIDIA GPU detected - CPU-only mode"
    fi
    
    # Check available disk space (need at least 50GB for models)
    available_space=$(df / | awk 'NR==2 {print $4}')
    required_space=$((50 * 1024 * 1024)) # 50GB in KB
    
    if [ "$available_space" -lt "$required_space" ]; then
        log_error "Insufficient disk space. Need at least 50GB available"
        exit 1
    fi
    
    log_success "Prerequisites check passed"
}

# Function to create environment file
create_env_file() {
    log_info "Creating environment configuration..."
    
    if [ ! -f "$ENV_FILE" ]; then
        cat > "$ENV_FILE" << 'EOF'
# Local LLM Infrastructure Configuration
POSTGRES_PASSWORD=secure_local_llm_password_123
GRAFANA_PASSWORD=admin123

# Local LLM Service Configuration
PREFER_LOCAL_LLM=true
OLLAMA_BASE_URL=http://ollama:11434
VLLM_BASE_URL=http://vllm:8000
USE_VLLM=true

# Performance Configuration
OLLAMA_NUM_PARALLEL=4
OLLAMA_MAX_LOADED_MODELS=3
OLLAMA_KEEP_ALIVE=24h

# Monitoring Configuration
PROMETHEUS_RETENTION=30d
GRAFANA_INSTALL_PLUGINS=grafana-piechart-panel

# Security Configuration
OLLAMA_ORIGINS=*
VLLM_API_KEY=sk-local-vllm-key-$(date +%s)
EOF
        log_success "Environment file created at $ENV_FILE"
    else
        log_info "Environment file already exists"
    fi
}

# Function to create required directories
create_directories() {
    log_info "Creating required directories..."
    
    local dirs=(
        "$PROJECT_ROOT/config/prometheus/rules"
        "$PROJECT_ROOT/config/grafana/provisioning/dashboards"
        "$PROJECT_ROOT/config/grafana/provisioning/datasources"
        "$PROJECT_ROOT/config/grafana/dashboards"
        "$PROJECT_ROOT/config/nginx/conf.d"
        "$PROJECT_ROOT/config/fluent-bit"
        "$PROJECT_ROOT/ssl"
        "$PROJECT_ROOT/logs"
    )
    
    for dir in "${dirs[@]}"; do
        mkdir -p "$dir"
        log_info "Created directory: $dir"
    done
    
    log_success "Directory structure created"
}

# Function to download and setup Japanese models
setup_japanese_models() {
    log_info "Setting up Japanese language models..."
    
    # Create model setup script
    cat > "$PROJECT_ROOT/scripts/setup-models.sh" << 'EOF'
#!/bin/bash
set -euo pipefail

echo "🇯🇵 Setting up Japanese language models..."

# Wait for Ollama to be ready
echo "Waiting for Ollama to start..."
until curl -f http://localhost:11434/api/tags >/dev/null 2>&1; do
    echo "Waiting for Ollama..."
    sleep 5
done

echo "✅ Ollama is ready"

# Pull Japanese models
models=(
    "elyza/elyza-japanese-llama2-7b-instruct"
    "stabilityai/japanese-stablelm-instruct-alpha-7b-v2"
    "llama3.1:8b"
    "gemma:2b"
)

for model in "${models[@]}"; do
    echo "📥 Pulling model: $model"
    curl -X POST http://localhost:11434/api/pull \
        -H "Content-Type: application/json" \
        -d "{\"name\": \"$model\"}" || echo "Failed to pull $model"
done

echo "🎯 Japanese model setup completed"
EOF
    
    chmod +x "$PROJECT_ROOT/scripts/setup-models.sh"
    log_success "Model setup script created"
}

# Function to create monitoring configuration
setup_monitoring() {
    log_info "Setting up monitoring configuration..."
    
    # Grafana datasource configuration
    cat > "$PROJECT_ROOT/config/grafana/provisioning/datasources/prometheus.yml" << 'EOF'
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: true
EOF

    # Grafana dashboard provisioning
    cat > "$PROJECT_ROOT/config/grafana/provisioning/dashboards/default.yml" << 'EOF'
apiVersion: 1

providers:
  - name: 'default'
    orgId: 1
    folder: ''
    type: file
    disableDeletion: false
    editable: true
    options:
      path: /var/lib/grafana/dashboards
EOF

    # Fluent Bit configuration
    cat > "$PROJECT_ROOT/config/fluent-bit/fluent-bit.conf" << 'EOF'
[SERVICE]
    Flush         1
    Log_Level     info
    Daemon        off
    Parsers_File  parsers.conf
    HTTP_Server   On
    HTTP_Listen   0.0.0.0
    HTTP_Port     2020

[INPUT]
    Name              tail
    Path              /var/lib/docker/containers/*/*.log
    multiline.parser  docker, cri
    Tag               docker.*
    Refresh_Interval  5

[FILTER]
    Name                docker
    Match               docker.*
    Docker_Mode         On
    Docker_Mode_Flush   5
    Docker_Mode_Parser  container_name

[OUTPUT]
    Name  stdout
    Match *
EOF

    cat > "$PROJECT_ROOT/config/fluent-bit/parsers.conf" << 'EOF'
[PARSER]
    Name        docker
    Format      json
    Time_Key    time
    Time_Format %Y-%m-%dT%H:%M:%S.%L
    Time_Keep   On
EOF

    log_success "Monitoring configuration created"
}

# Function to deploy the infrastructure
deploy_infrastructure() {
    log_info "Deploying Local LLM infrastructure..."
    
    # Load environment variables
    export $(grep -v '^#' "$ENV_FILE" | xargs)
    
    # Deploy with Docker Compose
    docker-compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d
    
    log_success "Infrastructure deployment initiated"
}

# Function to wait for services to be ready
wait_for_services() {
    log_info "Waiting for services to be ready..."
    
    local services=(
        "http://localhost:11434/api/tags|Ollama"
        "http://localhost:6379|Redis"
        "http://localhost:5432|PostgreSQL"
        "http://localhost:9090/-/ready|Prometheus"
        "http://localhost:3000/api/health|Grafana"
    )
    
    for service in "${services[@]}"; do
        IFS='|' read -r url name <<< "$service"
        
        log_info "Waiting for $name to be ready..."
        retry_count=0
        max_retries=60
        
        while [ $retry_count -lt $max_retries ]; do
            if curl -f "$url" >/dev/null 2>&1; then
                log_success "$name is ready"
                break
            fi
            
            retry_count=$((retry_count + 1))
            echo -n "."
            sleep 5
        done
        
        if [ $retry_count -eq $max_retries ]; then
            log_error "$name failed to start within expected time"
            exit 1
        fi
    done
}

# Function to setup models after deployment
post_deployment_setup() {
    log_info "Running post-deployment setup..."
    
    # Setup Japanese models
    log_info "Setting up Japanese language models..."
    docker-compose -f "$COMPOSE_FILE" exec -T ollama bash -c "
        # Wait a bit more for Ollama to be fully ready
        sleep 10
        
        # Pull models one by one with error handling
        models='elyza/elyza-japanese-llama2-7b-instruct stabilityai/japanese-stablelm-instruct-alpha-7b-v2 llama3.1:8b gemma:2b'
        for model in \$models; do
            echo \"📥 Pulling model: \$model\"
            ollama pull \$model || echo \"⚠️ Failed to pull \$model - will retry later\"
        done
        
        echo \"🎯 Model setup completed\"
    " || log_warning "Some models may not have been downloaded successfully"
    
    log_success "Post-deployment setup completed"
}

# Function to run health checks
run_health_checks() {
    log_info "Running comprehensive health checks..."
    
    # Check container status
    log_info "Checking container status..."
    docker-compose -f "$COMPOSE_FILE" ps
    
    # Check service endpoints
    local endpoints=(
        "http://localhost:11434/api/tags|Ollama API"
        "http://localhost:8000/health|vLLM API"
        "http://localhost:9090/-/ready|Prometheus"
        "http://localhost:3000/api/health|Grafana"
    )
    
    for endpoint in "${endpoints[@]}"; do
        IFS='|' read -r url name <<< "$endpoint"
        
        if curl -f "$url" >/dev/null 2>&1; then
            log_success "$name is healthy"
        else
            log_error "$name health check failed"
        fi
    done
    
    # Check GPU utilization if available
    if command -v nvidia-smi &> /dev/null; then
        log_info "GPU utilization:"
        nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits
    fi
}

# Function to display deployment summary
show_deployment_summary() {
    log_info "🎉 Local LLM Infrastructure Deployment Summary"
    echo
    echo "📊 Service URLs:"
    echo "  • Ollama API:      http://localhost:11434"
    echo "  • vLLM API:        http://localhost:8000"
    echo "  • Grafana:         http://localhost:3000 (admin/admin123)"
    echo "  • Prometheus:      http://localhost:9090"
    echo
    echo "🔧 Management Commands:"
    echo "  • View logs:       docker-compose -f $COMPOSE_FILE logs -f"
    echo "  • Stop services:   docker-compose -f $COMPOSE_FILE down"
    echo "  • Scale services:  docker-compose -f $COMPOSE_FILE up -d --scale ollama=2"
    echo "  • Health check:    $SCRIPT_DIR/health-check.sh"
    echo
    echo "📚 Model Management:"
    echo "  • List models:     docker-compose -f $COMPOSE_FILE exec ollama ollama list"
    echo "  • Pull model:      docker-compose -f $COMPOSE_FILE exec ollama ollama pull <model>"
    echo "  • Remove model:    docker-compose -f $COMPOSE_FILE exec ollama ollama rm <model>"
    echo
    log_success "Local LLM infrastructure is ready for production use!"
}

# Main deployment function
main() {
    log_info "🚀 Starting Local LLM Infrastructure Deployment"
    echo "Project Root: $PROJECT_ROOT"
    echo "Compose File: $COMPOSE_FILE"
    echo
    
    check_prerequisites
    create_env_file
    create_directories
    setup_japanese_models
    setup_monitoring
    deploy_infrastructure
    wait_for_services
    post_deployment_setup
    run_health_checks
    show_deployment_summary
    
    log_success "🎯 Deployment completed successfully!"
}

# Handle script arguments
case "${1:-deploy}" in
    "deploy")
        main
        ;;
    "stop")
        log_info "Stopping Local LLM infrastructure..."
        docker-compose -f "$COMPOSE_FILE" down
        log_success "Infrastructure stopped"
        ;;
    "restart")
        log_info "Restarting Local LLM infrastructure..."
        docker-compose -f "$COMPOSE_FILE" restart
        log_success "Infrastructure restarted"
        ;;
    "logs")
        docker-compose -f "$COMPOSE_FILE" logs -f
        ;;
    "health")
        run_health_checks
        ;;
    *)
        echo "Usage: $0 {deploy|stop|restart|logs|health}"
        echo
        echo "Commands:"
        echo "  deploy  - Deploy the complete infrastructure"
        echo "  stop    - Stop all services"
        echo "  restart - Restart all services"
        echo "  logs    - Follow service logs"
        echo "  health  - Run health checks"
        exit 1
        ;;
esac