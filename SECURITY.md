# Security and deployment boundary

Use a private HTTPS Gateway and a confidential OpenID Connect client. The server
filters application catalogues, search results and saved preferences against the
current authenticated groups. Application services must enforce their own access
policies as well; a launcher is not an authorization proxy for linked services.

Keep credentials in the deployment platform's secret facility. The public
repository contains only generic examples. This launcher holds no linked
application API keys and does not proxy their metrics or user data. Never enable
the loopback-only demonstration mode in production.

The initial deployment uses one replica and in-memory sessions. Restarts require
sign-in again. Group revocation is checked through the identity provider; see
the README for the bounded refresh interval and outage behavior. The server has
no Kubernetes token, container socket, host filesystem or cluster-admin role.

Report vulnerabilities using GitHub's private vulnerability reporting feature
when available. Do not post access tokens, session cookies, private catalogues or
personal information in public issues.
