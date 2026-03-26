// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title LLMTraderOracle
 * @notice On-chain oracle for individual AI model trading signals.
 *         Each model produces its own independent heuristic, there is NO consensus
 *         aggregation. Consumers can either decide how to weight/combine signals, or USE OUR MASTER SIGNAL.
 *         Supports dynamic token pricing (top 100 by market cap).
 *
 *         V2: Ownable2Step + Pausable killswitch + mutable forwarder.
 */
contract LLMTraderOracle is Ownable2Step, Pausable {
    uint8 public constant HOLD = 0;
    uint8 public constant BUY  = 1;
    uint8 public constant SELL = 2;

    struct ModelSignal {
        bytes32 modelId;
        uint8   direction;
        uint8   confidence;
    }

    struct Report {
        uint256 tokenCount;
        uint256 modelCount;
        uint256 timestamp;
    }

    Report public latestReport;

    mapping(bytes32 => uint256) public latestPrices;
    bytes32[] public priceTokenIds;

    mapping(bytes32 => ModelSignal) public latestSignals;
    bytes32[] public modelIds;

    address public donForwarder;

    event SignalsUpdated(uint256 tokenCount, uint256 modelCount, uint256 timestamp);
    event ModelSignalRecorded(bytes32 indexed modelId, uint8 direction, uint8 confidence);
    event ForwarderUpdated(address indexed oldForwarder, address indexed newForwarder);

    error UnauthorizedForwarder(address caller);
    error InvalidDirection(uint8 direction);
    error InvalidConfidence(uint8 confidence);
    error ArrayLengthMismatch();

    constructor(address _donForwarder, address _initialOwner) Ownable(_initialOwner) {
        donForwarder = _donForwarder;
    }

    function onReport(bytes calldata, bytes calldata report) external whenNotPaused {
        if (msg.sender != donForwarder) {
            revert UnauthorizedForwarder(msg.sender);
        }

        (
            bytes32[] memory _tokenIds,
            uint256[] memory _prices,
            uint8     modelCount,
            bytes32[] memory _modelIds,
            uint8[]   memory directions,
            uint8[]   memory confidences
        ) = abi.decode(report, (bytes32[], uint256[], uint8, bytes32[], uint8[], uint8[]));

        if (_tokenIds.length != _prices.length) revert ArrayLengthMismatch();

        delete priceTokenIds;
        for (uint256 i = 0; i < _tokenIds.length; i++) {
            latestPrices[_tokenIds[i]] = _prices[i];
            priceTokenIds.push(_tokenIds[i]);
        }

        delete modelIds;
        for (uint256 i = 0; i < modelCount; i++) {
            if (directions[i] > 2) revert InvalidDirection(directions[i]);
            if (confidences[i] > 100) revert InvalidConfidence(confidences[i]);

            bytes32 mid = _modelIds[i];
            latestSignals[mid] = ModelSignal({
                modelId:    mid,
                direction:  directions[i],
                confidence: confidences[i]
            });
            modelIds.push(mid);
            emit ModelSignalRecorded(mid, directions[i], confidences[i]);
        }

        latestReport = Report({
            tokenCount: _tokenIds.length,
            modelCount: modelCount,
            timestamp:  block.timestamp
        });

        emit SignalsUpdated(_tokenIds.length, modelCount, block.timestamp);
    }

    // Killswitch
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function setForwarder(address _new) external onlyOwner {
        require(_new != address(0), "Zero address");
        address old = donForwarder;
        donForwarder = _new;
        emit ForwarderUpdated(old, _new);
    }

    // View functions
    function getPrice(bytes32 tokenId) external view returns (uint256) { return latestPrices[tokenId]; }
    function getPriceTokenIds() external view returns (bytes32[] memory) { return priceTokenIds; }
    function getTokenCount() external view returns (uint256) { return priceTokenIds.length; }
    function getModelCount() external view returns (uint256) { return modelIds.length; }
    function getSignal(bytes32 modelId) external view returns (ModelSignal memory) { return latestSignals[modelId]; }
    function getModelIds() external view returns (bytes32[] memory) { return modelIds; }
}
