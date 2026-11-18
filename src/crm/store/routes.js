// The Store module's routes, mounted at /w/:wid/crm. A route only checks the body and the role
// and calls the file that does the work. Team members work with products, stock and orders;
// deleting and refunds are for admins and the owner.
//
// Every write answers { changes: { set: { orders, products, movements, customers? }, del }, rev }
// with every row it touched. A rule that says no answers 422 { code: "rules", hard: [reason],
// soft: [reason] } (reasons are codes with their numbers, see ../shared/store.js); `force: true`
// passes soft reasons when the workspace lets the team plan outside its delivery rules.
import { Router } from "express";
import { wrap } from "../../core/http.js";
import { validate } from "../../core/validate.js";
import { requireRole } from "../../core/workspaces/access.js";
import { productCreateSchema, productUpdateSchema, createProduct, updateProduct, deleteProduct } from "./products.js";
import { acceptImage, uploadImage, setProductImage, sendImage } from "./images.js";
import { receiveSchema, writeOffSchema, countSchema, receive, writeOff, count } from "./stock.js";
import { orderCreateSchema, orderUpdateSchema, createOrder, updateOrder, deleteOrder } from "./orders.js";
import { stepSchema, cancelSchema, moveOrder, cancelOrder } from "./steps.js";
import { paySchema, refundSchema, payOrder, refundOrder } from "./payments.js";
import { receipt } from "./receipt.js";

export const router = Router({ mergeParams: true });
const admin = requireRole("admin");
const ws = (req) => req.workspace;
// The signed-in person, with the branch they are limited to (branchOnly, see ../branches/access.js).
const by = (req) => ({ ...req.user, branchOnly: req.branchOnly });

// Products
router.post("/products", validate(productCreateSchema), wrap(async (req, res) => res.status(201).json(await createProduct(ws(req), by(req), req.valid))));
router.put("/products/:id", validate(productUpdateSchema), wrap(async (req, res) => res.json(await updateProduct(ws(req), by(req), req.params.id, req.valid))));
router.delete("/products/:id", admin, wrap(async (req, res) => res.json(await deleteProduct(ws(req), req.params.id))));
// Pictures: upload one and get its path back (for a product that isn't saved yet), or set a product's picture in one go.
router.post("/products/images", acceptImage, wrap(async (req, res) => res.status(201).json(await uploadImage(ws(req), req.file))));
router.post("/products/:id/image", acceptImage, wrap(async (req, res) => res.json(await setProductImage(ws(req), req.params.id, req.file))));
router.get("/products/images/:name", wrap((req, res) => sendImage(res, ws(req), req.params.name)));

// Stock
router.post("/stock/receive", validate(receiveSchema), wrap(async (req, res) => res.json(await receive(ws(req), by(req), req.valid))));
router.post("/stock/write-off", validate(writeOffSchema), wrap(async (req, res) => res.json(await writeOff(ws(req), by(req), req.valid))));
router.post("/stock/count", validate(countSchema), wrap(async (req, res) => res.json(await count(ws(req), by(req), req.valid))));

// Orders
router.post("/orders", validate(orderCreateSchema), wrap(async (req, res) => res.status(201).json(await createOrder(ws(req).id, by(req), req.valid))));
router.put("/orders/:id", validate(orderUpdateSchema), wrap(async (req, res) => res.json(await updateOrder(ws(req), by(req), req.params.id, req.valid))));
router.delete("/orders/:id", admin, wrap(async (req, res) => res.json(await deleteOrder(ws(req), req.params.id))));
router.post("/orders/:id/step", validate(stepSchema), wrap(async (req, res) => res.json(await moveOrder(ws(req), by(req), req.params.id, req.valid))));
router.post("/orders/:id/cancel", validate(cancelSchema), wrap(async (req, res) => res.json(await cancelOrder(ws(req), by(req), req.params.id, req.valid))));
router.post("/orders/:id/pay", validate(paySchema), wrap(async (req, res) => res.json(await payOrder(ws(req), by(req), req.params.id, req.valid))));
router.post("/orders/:id/refund", admin, validate(refundSchema), wrap(async (req, res) => res.json(await refundOrder(ws(req), by(req), req.params.id, req.valid))));
router.get("/orders/:id/receipt", wrap(async (req, res) => res.json(await receipt(req.ctx(), req.params.id))));
