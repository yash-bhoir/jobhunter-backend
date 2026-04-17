/**
 * Top tech & product companies indexed by job board platform.
 * All three platforms expose free public APIs — no auth required.
 *
 * Add more companies by appending to the relevant section.
 * slug = the company identifier used in that platform's API URL.
 */

const GREENHOUSE = [
  // AI / ML
  { name: 'Anthropic',      slug: 'anthropic'      },
  { name: 'Cohere',         slug: 'cohere'         },
  { name: 'Scale AI',       slug: 'scaleai'        },
  { name: 'Hugging Face',   slug: 'huggingface'    },
  { name: 'Stability AI',   slug: 'stabilityai'    },
  // Cloud / Infra
  { name: 'Stripe',         slug: 'stripe'         },
  { name: 'Cloudflare',     slug: 'cloudflare'     },
  { name: 'Datadog',        slug: 'datadog'        },
  { name: 'HashiCorp',      slug: 'hashicorp'      },
  { name: 'Confluent',      slug: 'confluent'      },
  { name: 'Cockroach Labs', slug: 'cockroachlabs'  },
  { name: 'PlanetScale',    slug: 'planetscale'    },
  // Product / SaaS
  { name: 'Notion',         slug: 'notion'         },
  { name: 'Linear',         slug: 'linear'         },
  { name: 'Retool',         slug: 'retool'         },
  { name: 'Airtable',       slug: 'airtable'       },
  { name: 'Zapier',         slug: 'zapier'         },
  { name: 'Intercom',       slug: 'intercom'       },
  { name: 'Figma',          slug: 'figma'          },
  { name: 'Canva',          slug: 'canva'          },
  { name: 'Miro',           slug: 'mirohq'         },
  { name: 'Amplitude',      slug: 'amplitude'      },
  { name: 'Mixpanel',       slug: 'mixpanel'       },
  { name: 'Brex',           slug: 'brex'           },
  { name: 'Gusto',          slug: 'gusto'          },
  { name: 'Rippling',       slug: 'rippling'       },
  { name: 'Deel',           slug: 'deel'           },
  { name: 'Remote',         slug: 'remote'         },
  // Dev tools
  { name: 'Vercel',         slug: 'vercel'         },
  { name: 'Netlify',        slug: 'netlify'        },
  { name: 'Supabase',       slug: 'supabase'       },
  { name: 'PagerDuty',      slug: 'pagerduty'      },
  { name: 'Postman',        slug: 'postman'        },
];

const ASHBY = [
  // AI / ML
  { name: 'OpenAI',         slug: 'openai'         },
  { name: 'Mistral',        slug: 'mistral'        },
  { name: 'LangChain',      slug: 'langchain'      },
  { name: 'Pinecone',       slug: 'pinecone'       },
  { name: 'ElevenLabs',     slug: 'elevenlabs'     },
  { name: 'Hume AI',        slug: 'humeai'         },
  { name: 'Perplexity',     slug: 'perplexity'     },
  { name: 'Together AI',    slug: 'togetherai'     },
  // Fintech / Commerce
  { name: 'Mercury',        slug: 'mercury'        },
  { name: 'Ramp',           slug: 'ramp'           },
  { name: 'Carta',          slug: 'carta'          },
  { name: 'Lemon Squeezy',  slug: 'lemonsqueezy'   },
  // Dev / Platform
  { name: 'Railway',        slug: 'railway'        },
  { name: 'Render',         slug: 'render'         },
  { name: 'Turso',          slug: 'turso'          },
  { name: 'Neon',           slug: 'neon'           },
  { name: 'Upstash',        slug: 'upstash'        },
  { name: 'Resend',         slug: 'resend'         },
];

const LEVER = [
  // Big tech offshoots / fast-growing
  { name: 'Atlassian',      slug: 'atlassian'      },
  { name: 'Shopify',        slug: 'shopify'        },
  { name: 'Discord',        slug: 'discord'        },
  { name: 'Twitch',         slug: 'twitch'         },
  { name: 'Duolingo',       slug: 'duolingo'       },
  { name: 'Grammarly',      slug: 'grammarly'      },
  { name: 'Asana',          slug: 'asana'          },
  { name: 'Monday.com',     slug: 'mondaydotcom'   },
  { name: 'ClickUp',        slug: 'clickup'        },
  { name: 'Webflow',        slug: 'webflow'        },
  { name: 'Loom',           slug: 'loom'           },
  { name: 'Calm',           slug: 'calm'           },
  { name: 'Headspace',      slug: 'headspace'      },
  // Indian tech companies on Lever
  { name: 'Razorpay',       slug: 'razorpay'       },
  { name: 'Groww',          slug: 'groww'          },
  { name: 'Zepto',          slug: 'zepto'          },
  { name: 'CRED',           slug: 'cred'           },
];

module.exports = { GREENHOUSE, ASHBY, LEVER };
