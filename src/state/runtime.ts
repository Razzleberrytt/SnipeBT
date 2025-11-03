let liveTradingEnabled = true;

export const pauseLiveTrading = () => {
  liveTradingEnabled = false;
};

export const resumeLiveTrading = () => {
  liveTradingEnabled = true;
};

export const isLiveTradingEnabled = () => liveTradingEnabled;
