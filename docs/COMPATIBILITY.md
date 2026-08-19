# Compatibility boundary

The project deliberately separates two chart surfaces:

| Capability | Official Supercharts browser | Local Lightweight Charts viewer |
| --- | --- | --- |
| TradingView account layouts and entitled data | Yes | No |
| Built-in/community indicator dialog | Yes | No |
| Official chart-data CSV export | Yes | Imports the result |
| Deterministic custom CVD/scenario series | Via exported columns only | Yes |
| Max Pain / OP walls / expected-range levels | Manual drawing | Yes, by API/MCP |
| Future zones and trajectory paths | Manual drawing | Yes, by API/MCP |
| Reproducible headless snapshot | Yes | Yes |

The local viewer is not a clone of proprietary TradingView charting features. It is a deterministic rendering surface for user-provided or locally calculated data; the official browser is retained for account-authorized TradingView data, layouts, indicators, and visual cross-checking.
