const axios = require("axios");

const getCourseInitIdParam = () => {
  try {
    require.resolve("./../course_init_id");
    const { courseInitId } = require("../course_init_id");
    console.log("Loaded courseInitId:", courseInitId);

    return courseInitId ? `${courseInitId}` : "";
  } catch (error) {
    return "";
  }
};

async function requestNetsQr(cartTotal) {
  const requestBody = {
    txn_id: "sandbox_nets|m|8ff8e5b6-d43e-4786-8ac5-7accf8c5bd9b", // Default for testing
    amt_in_dollars: cartTotal,
    notify_mobile: 0,
  };

  const response = await axios.post(
    "https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets-qr/request",
    requestBody,
    {
      headers: {
        "api-key": process.env.API_KEY,
        "project-id": process.env.PROJECT_ID,
      },
    }
  );

  const qrData = response.data.result.data;
  const txnRetrievalRef = qrData.txn_retrieval_ref;
  const courseInitId = getCourseInitIdParam();
  const webhookUrl = `https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets/webhook?txn_retrieval_ref=${txnRetrievalRef}&course_init_id=${courseInitId}`;

  return {
    response,
    qrData,
    txnRetrievalRef,
    courseInitId,
    webhookUrl,
  };
}

async function queryNetsQrStatus(txnRetrievalRef, frontendTimeoutStatus = 0) {
  const payload = {
    txn_retrieval_ref: txnRetrievalRef,
    frontend_timeout_status: frontendTimeoutStatus,
  };

  return axios.post(
    "https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets-qr/query",
    payload,
    {
      headers: {
        "api-key": process.env.API_KEY,
        "project-id": process.env.PROJECT_ID,
        "Content-Type": "application/json",
      },
    }
  );
}

exports.generateQrCode = async (req, res) => {
  const { cartTotal } = req.body;
  console.log(cartTotal);
  try {
    const { response, qrData, txnRetrievalRef, courseInitId, webhookUrl } =
      await requestNetsQr(cartTotal);
    console.log({ qrData });

    if (
      qrData.response_code === "00" &&
      qrData.txn_status === 1 &&
      qrData.qr_code
    ) {
      console.log("QR code generated successfully");

      // Render the QR code page with required data
      if (req.session && req.session.pendingCheckout) {
        req.session.pendingCheckout.netsTxnRetrievalRef = txnRetrievalRef;
      }

      res.render("netsQr", {
        total: cartTotal,
        title: "Scan to Pay",
        qrCodeUrl: `data:image/png;base64,${qrData.qr_code}`,
        txnRetrievalRef: txnRetrievalRef,
        courseInitId: courseInitId,
        networkCode: qrData.network_status,
        timer: 300, // Timer in seconds
        webhookUrl: webhookUrl,
        fullNetsResponse: response.data,
        apiKey: process.env.API_KEY,
        projectId: process.env.PROJECT_ID,
      });
    } else {
      // Handle partial or failed responses
      let errorMsg = "An error occurred while generating the QR code.";
      if (qrData.network_status !== 0) {
        errorMsg =
          qrData.error_message || "Transaction failed. Please try again.";
      }
      res.render("netsQrFail", {
        title: "Error",
        responseCode: qrData.response_code || "N.A.",
        instructions: qrData.instruction || "",
        errorMsg: errorMsg,
      });
    }
  } catch (error) {
    console.error("Error in generateQrCode:", error.message);
    res.redirect("/nets-qr/fail");
  }
};

exports.generateQrData = async (cartTotal) => {
  const { response, qrData, txnRetrievalRef, courseInitId, webhookUrl } =
    await requestNetsQr(cartTotal);

  if (
    qrData.response_code === "00" &&
    qrData.txn_status === 1 &&
    qrData.qr_code
  ) {
    return {
      success: true,
      total: cartTotal,
      qrCodeUrl: `data:image/png;base64,${qrData.qr_code}`,
      txnRetrievalRef,
      courseInitId,
      networkCode: qrData.network_status,
      timer: 300,
      webhookUrl,
      fullNetsResponse: response.data,
      apiKey: process.env.API_KEY,
      projectId: process.env.PROJECT_ID,
    };
  }

  let errorMsg = "An error occurred while generating the QR code.";
  if (qrData.network_status !== 0) {
    errorMsg = qrData.error_message || "Transaction failed. Please try again.";
  }

  return {
    success: false,
    responseCode: qrData.response_code || "N.A.",
    instructions: qrData.instruction || "",
    errorMsg,
  };
};

exports.queryNetsQrStatus = queryNetsQrStatus;
