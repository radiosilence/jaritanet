#!/bin/bash

# monitoring-access.sh
# Quick access script for JaritaNet monitoring services

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
    echo -e "${RED}Error: kubectl is not installed or not in PATH${NC}"
    exit 1
fi

# Check if we can connect to the cluster
if ! kubectl cluster-info &> /dev/null; then
    echo -e "${RED}Error: Cannot connect to Kubernetes cluster${NC}"
    exit 1
fi

# Check if monitoring services exist
echo -e "${BLUE}Checking monitoring services...${NC}"

if ! kubectl get service prometheus-service -n jaritanet &> /dev/null; then
    echo -e "${RED}Error: Prometheus service not found in jaritanet namespace${NC}"
    echo -e "${YELLOW}Make sure the monitoring stack is deployed${NC}"
    exit 1
fi

if ! kubectl get service grafana-service -n jaritanet &> /dev/null; then
    echo -e "${RED}Error: Grafana service not found in jaritanet namespace${NC}"
    echo -e "${YELLOW}Make sure the monitoring stack is deployed${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Monitoring services found${NC}"
echo -e "${BLUE}Starting port forwards for monitoring services...${NC}"

# Function to cleanup on exit
cleanup() {
    echo -e "\n${YELLOW}Stopping port forwards...${NC}"
    if [ ! -z "$PROM_PID" ]; then
        kill $PROM_PID 2>/dev/null || true
    fi
    if [ ! -z "$GRAFANA_PID" ]; then
        kill $GRAFANA_PID 2>/dev/null || true
    fi
    echo -e "${GREEN}Port forwards stopped${NC}"
    exit 0
}

# Set trap for cleanup
trap cleanup INT TERM

# Start Prometheus port forward in background
echo -e "${BLUE}Starting Prometheus port forward...${NC}"
kubectl port-forward -n jaritanet service/prometheus-service 9090:9090 > /dev/null 2>&1 &
PROM_PID=$!

# Wait a moment for port forward to establish
sleep 2

# Check if Prometheus port forward is working
if ! kill -0 $PROM_PID 2>/dev/null; then
    echo -e "${RED}Failed to start Prometheus port forward${NC}"
    exit 1
fi

# Start Grafana port forward in background
echo -e "${BLUE}Starting Grafana port forward...${NC}"
kubectl port-forward -n jaritanet service/grafana-service 3000:3000 > /dev/null 2>&1 &
GRAFANA_PID=$!

# Wait a moment for port forward to establish
sleep 2

# Check if Grafana port forward is working
if ! kill -0 $GRAFANA_PID 2>/dev/null; then
    echo -e "${RED}Failed to start Grafana port forward${NC}"
    kill $PROM_PID 2>/dev/null || true
    exit 1
fi

echo -e "${GREEN}✓ Port forwards started successfully${NC}"
echo ""
echo -e "${GREEN}🔗 Access URLs:${NC}"
echo -e "  Prometheus: ${BLUE}http://localhost:9090${NC}"
echo -e "  Grafana:    ${BLUE}http://localhost:3000${NC}"
echo ""
echo -e "${YELLOW}📊 Grafana Login:${NC}"
echo -e "  Username: admin"
echo -e "  Password: admin123"
echo ""
echo -e "${YELLOW}📈 Available Dashboards:${NC}"
echo -e "  • Kubernetes Overview"
echo -e "  • JaritaNet Services"
echo ""
echo -e "${GREEN}Press Ctrl+C to stop port forwards${NC}"

# Keep script running and wait for interrupt
while true; do
    # Check if port forwards are still running
    if ! kill -0 $PROM_PID 2>/dev/null; then
        echo -e "${RED}Prometheus port forward died unexpectedly${NC}"
        cleanup
    fi
    
    if ! kill -0 $GRAFANA_PID 2>/dev/null; then
        echo -e "${RED}Grafana port forward died unexpectedly${NC}"
        cleanup
    fi
    
    sleep 5
done