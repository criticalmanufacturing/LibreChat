#!/bin/sh

SECURITY_PORTAL_READY_URL="http://securityportal:8080/SecurityPortal/api/ready"

echo "Waiting for the security portal to be ready at: $SECURITY_PORTAL_READY_URL"

until [ "$(curl -s -o /dev/null -w "%{http_code}" "$SECURITY_PORTAL_READY_URL")" -eq 200 ]; do
  echo "Security portal is not ready yet. Retrying in 5 seconds..."
  sleep 5
done

echo "Security portal is ready! Starting LibreChat..."

exec "$@"