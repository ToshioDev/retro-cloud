#!/bin/bash
# ── Coturn (TURN server) setup for Oracle Cloud VPS ──────────────────────────
# Run this ONCE on the production VPS (23.138.88.186) as root.
# After setup, add TURN_URL, TURN_SHARED_SECRET env vars to Coolify's signaling service.
#
# Usage: sudo bash setup-coturn-vps.sh
#
set -euo pipefail

TURN_SECRET="retro-cloud-turn-secret-change-me-in-production"
VPS_IP="23.138.88.186"

echo "=== Installing Coturn ==="
apt-get update && apt-get install -y coturn

echo "=== Configuring Coturn ==="
cat > /etc/turnserver.conf <<EOF
# Listening
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0

# Relay
relay-ip=${VPS_IP}
external-ip=${VPS_IP}
min-port=49152
max-port=65535

# Auth (shared-secret mode — signaling server generates HMAC creds)
use-auth-secret
static-auth-secret=${TURN_SECRET}

# Security
no-tls
no-dtls
no-loopback-peers
no-multicast-peers

# Logging
log-file=/var/log/turnserver.log
verbose

# Performance
relay-threads=2
total-quota=128
stale-nonce=600
max-bps=0
EOF

echo "=== Enabling Coturn in systemd ==="
sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
systemctl enable coturn
systemctl restart coturn

echo "=== Opening firewall ports ==="
# Oracle Cloud uses iptables; also try ufw in case it's installed
if command -v ufw &>/dev/null; then
    ufw allow 3478/udp comment "TURN STUN/TURN"
    ufw allow 3478/tcp comment "TURN STUN/TURN TCP"
    ufw allow 49152:65535/udp comment "TURN relay range"
else
    iptables -I INPUT -p udp --dport 3478 -j ACCEPT
    iptables -I INPUT -p tcp --dport 3478 -j ACCEPT
    iptables -I INPUT -p udp --dport 49152:65535 -j ACCEPT
    # Persist iptables rules
    if command -v iptables-save &>/dev/null; then
        iptables-save > /etc/iptables.rules 2>/dev/null || true
    fi
fi

echo ""
echo "=== Done! ==="
echo "Coturn is running on ${VPS_IP}:3478"
echo ""
echo "Add these env vars to Coolify's signaling service:"
echo "  TURN_URL=turn:${VPS_IP}:3478"
echo "  TURN_SHARED_SECRET=${TURN_SECRET}"
echo ""
echo "Verify with: sudo systemctl status coturn"
echo "Test with:   turnutils_uclient -T -u user -w secret ${VPS_IP}"
